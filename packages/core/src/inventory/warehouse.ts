import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "../platform/context";
import { featureOn } from "../platform/features";
import { ForbiddenError, requirePermission } from "../platform/permissions";
import { InsufficientStockError, postMovements, StockInputError } from "./ledger";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireFeature(ctx: Ctx, feature: "picking" | "putaway" | "counts") {
  if (!featureOn(ctx.features, "stock") || !featureOn(ctx.features, feature)) {
    // The feature is off, so the work it covers is withheld like any other permission.
    throw new ForbiddenError(feature === "picking" ? "sales_order.ship" : feature === "putaway" ? "purchase_order.receive" : "stock.adjust");
  }
}

export type PickLine = { sku: string; name: string; shelf: string | null; qty: number };
export type PickOrder = {
  id: string;
  number: string;
  customer: string;
  confirmedAt: Date | null;
  /** Units reserved and waiting to be picked. */
  units: number;
  /** Units ordered that have no stock yet, so they stay behind. */
  backorder: number;
  /** In walking order: by shelf, then product code. Lines with no shelf come last. */
  lines: PickLine[];
};

/** Orders with stock reserved and waiting to ship, oldest first. */
export async function pickQueue(ctx: Ctx): Promise<PickOrder[]> {
  requirePermission(ctx, "sales_order.read");
  requireFeature(ctx, "picking");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<{ id: string; number: string; customer: string; confirmedAt: Date | null; backorder: number; sku: string; name: string; shelf: string | null; qty: number }>(
      `select o.id, o.number, c.name as customer, o.confirmed_at as "confirmedAt",
              (select coalesce(sum(x.qty - x.qty_reserved - x.qty_shipped), 0)::float8
                 from sales_order_lines x where x.order_id = o.id) as backorder,
              p.sku, p.name, p.shelf_location as shelf, l.qty_reserved::float8 as qty
         from sales_orders o
         join customers c on c.id = o.customer_id
         join sales_order_lines l on l.order_id = o.id and l.qty_reserved > 0
         join products p on p.id = l.product_id
        where o.status in ('confirmed', 'partially_shipped')
        order by o.confirmed_at nulls last, o.number, p.shelf_location nulls last, p.sku`,
    );
    const orders = new Map<string, PickOrder>();
    for (const row of result.rows) {
      let order = orders.get(row.id);
      if (!order) {
        order = { id: row.id, number: row.number, customer: row.customer, confirmedAt: row.confirmedAt, units: 0, backorder: row.backorder, lines: [] };
        orders.set(row.id, order);
      }
      order.units += row.qty;
      order.lines.push({ sku: row.sku, name: row.name, shelf: row.shelf, qty: row.qty });
    }
    return [...orders.values()];
  });
}

export type PutawayLine = {
  id: string;
  productId: string;
  sku: string;
  name: string;
  shelf: string | null;
  qty: number;
  receipt: string;
  supplier: string;
  receivedAt: Date;
};

/** Received goods not yet moved to their shelves, oldest delivery first. */
export async function putawayList(ctx: Ctx): Promise<PutawayLine[]> {
  requirePermission(ctx, "purchase_order.read");
  requireFeature(ctx, "putaway");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<PutawayLine>(
      `select rl.id, p.id as "productId", p.sku, p.name, p.shelf_location as shelf, rl.qty::float8 as qty,
              r.number as receipt, s.name as supplier, r.received_at as "receivedAt"
         from receipt_lines rl
         join receipts r on r.id = rl.receipt_id
         join purchase_order_lines pl on pl.id = rl.order_line_id
         join purchase_orders po on po.id = pl.order_id
         join suppliers s on s.id = po.supplier_id
         join products p on p.id = pl.product_id
        where rl.put_away_at is null
        order by r.received_at, p.shelf_location nulls last, p.sku
        limit 500`,
    );
    return result.rows;
  });
}

/**
 * Ticks a received line as put away. Giving a shelf also records it as the product's shelf,
 * which is how a new product gets its first location.
 */
export async function markPutAway(ctx: Ctx, receiptLineId: string, input: { shelf?: string } = {}): Promise<void> {
  requirePermission(ctx, "purchase_order.receive");
  requireFeature(ctx, "putaway");
  if (!UUID.test(receiptLineId)) throw new StockInputError("That delivery line was not found.");
  const shelf = input.shelf?.trim() ?? "";
  if (shelf.length > 50) throw new StockInputError("Keep the shelf under 50 characters.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const done = await tx.query<{ product_id: string }>(
      `update receipt_lines rl set put_away_at = now(), put_away_by = $2
         from purchase_order_lines pl
        where rl.id = $1 and pl.id = rl.order_line_id and rl.put_away_at is null
        returning pl.product_id`,
      [receiptLineId, ctx.userId],
    );
    const row = done.rows[0];
    if (!row) return; // already put away, or not this company's: nothing to do
    if (shelf) await tx.query("update products set shelf_location = $2, updated_at = now() where id = $1", [row.product_id, shelf]);
  });
}

export type CountLine = { productId: string; sku: string; name: string; category: string | null; shelf: string | null; onHand: number; reserved: number };

/** What the records say is on the shelves, in shelf order, optionally for one category or aisle. */
export async function countSheet(ctx: Ctx, options: { category?: string; shelfPrefix?: string } = {}): Promise<CountLine[]> {
  requirePermission(ctx, "product.read");
  requireFeature(ctx, "counts");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<CountLine>(
      `select p.id as "productId", p.sku, p.name, p.category, p.shelf_location as shelf,
              coalesce(s.on_hand, 0)::float8 as "onHand", coalesce(s.reserved, 0)::float8 as reserved
         from products p
         left join (select product_id, sum(on_hand) as on_hand, sum(reserved) as reserved from stock_levels group by product_id) s
                on s.product_id = p.id
        where p.status = 'active'
          and ($1 = '' or p.category = $1)
          and ($2 = '' or p.shelf_location ilike replace(replace($2, '%', ''), '_', '') || '%')
        order by p.shelf_location nulls last, p.sku
        limit 500`,
      [options.category?.trim() ?? "", options.shelfPrefix?.trim() ?? ""],
    );
    return result.rows;
  });
}

export async function countCategories(ctx: Ctx): Promise<string[]> {
  requirePermission(ctx, "product.read");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<{ category: string }>(
      "select distinct category from products where status = 'active' and category is not null order by category",
    );
    return result.rows.map((r) => r.category);
  });
}

export type CountResult = { counted: number; changed: number; replayed: boolean };

/**
 * Records a stock count. Each product whose counted quantity differs from the records gets one
 * adjustment for the difference; products counted as expected change nothing. All or nothing:
 * if any line cannot be applied, none are.
 */
export async function submitCount(
  ctx: Ctx,
  input: { idempotencyKey: string; note?: string; lines: { productId: string; counted: number }[] },
): Promise<CountResult> {
  requirePermission(ctx, "stock.adjust");
  requireFeature(ctx, "counts");
  if (!input.idempotencyKey.trim()) throw new StockInputError("A request id is required.");
  if (input.lines.length === 0) throw new StockInputError("Enter at least one count.");
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (!UUID.test(line.productId)) throw new StockInputError("A counted product was not found.");
    if (seen.has(line.productId)) throw new StockInputError("A product appears twice in this count.");
    seen.add(line.productId);
    if (!Number.isFinite(line.counted) || line.counted < 0) throw new StockInputError("A count cannot be less than zero.");
    if (Math.round(line.counted * 10000) !== line.counted * 10000) throw new StockInputError("Counts can have at most four decimal places.");
  }
  const note = input.note?.trim().slice(0, 150) ?? "";
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const current = await tx.query<{ id: string; name: string; on_hand: number; reserved: number }>(
      `select p.id, p.name, coalesce(s.on_hand, 0)::float8 as on_hand, coalesce(s.reserved, 0)::float8 as reserved
         from products p
         left join (select product_id, sum(on_hand) as on_hand, sum(reserved) as reserved from stock_levels group by product_id) s
                on s.product_id = p.id
        where p.id = any($1::uuid[])`,
      [input.lines.map((l) => l.productId)],
    );
    const byId = new Map(current.rows.map((r) => [r.id, r]));
    const changes: { productId: string; qtyDelta: number }[] = [];
    for (const line of input.lines) {
      const product = byId.get(line.productId);
      if (!product) throw new StockInputError("A counted product was not found.");
      if (line.counted < product.reserved) {
        throw new StockInputError(
          `${product.name}: ${product.reserved} are reserved for orders, so the count cannot be lower than that. Ship or cancel those orders first.`,
        );
      }
      const delta = line.counted - product.on_hand;
      if (delta !== 0) changes.push({ productId: line.productId, qtyDelta: delta });
    }
    if (changes.length === 0) return { counted: input.lines.length, changed: 0, replayed: false };
    let result: { replayed: boolean };
    try {
      result = await postMovements(tx, ctx, {
        idempotencyKey: `count:${input.idempotencyKey}`,
        kind: "adjustment",
        lines: changes,
        reason: note ? `Stock count: ${note}` : "Stock count",
      });
    } catch (error) {
      if (error instanceof InsufficientStockError) throw new StockInputError("Stock changed while you were counting. Reload the sheet and try again.");
      throw error;
    }
    if (!result.replayed) {
      await tx.query(
        `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
         values ($1, 'user', $2, 'stock.counted', 'organization', $1, $3)`,
        [ctx.orgId, ctx.userId, JSON.stringify({ counted: input.lines.length, changes })],
      );
    }
    return { counted: input.lines.length, changed: changes.length, replayed: result.replayed };
  });
}
