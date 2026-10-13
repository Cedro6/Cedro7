import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "../platform/context";
import { ValidationError } from "../platform/errors";
import { can, requirePermission } from "../platform/permissions";

export type ProductSummary = {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  shelfLocation: string | null;
  barcode: string | null;
  price: number;
  /** Null when the role may not see cost. */
  cost: number | null;
  reorderPoint: number | null;
  /** False for goods that are never charged tax. */
  taxable: boolean;
  onHand: number;
  reserved: number;
  available: number;
  /** Ordered from suppliers and not yet received. */
  onOrder: number;
  /** Available stock is at or below the reorder point. */
  lowStock: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRODUCT_SQL = `
  select p.id, p.sku, p.name, p.category, p.shelf_location as "shelfLocation", p.barcode,
         p.price::float8 as price,
         case when $1 then p.cost::float8 end as cost,
         p.reorder_point::float8 as "reorderPoint", p.taxable,
         coalesce(s.on_hand, 0)::float8 as "onHand",
         coalesce(s.reserved, 0)::float8 as reserved,
         coalesce(s.on_hand - s.reserved, 0)::float8 as available,
         coalesce((select sum(pl.qty - pl.qty_received)
                   from purchase_order_lines pl join purchase_orders po on po.id = pl.order_id
                   where pl.product_id = p.id
                     and po.status in ('approved', 'sent', 'partially_received')), 0)::float8 as "onOrder",
         (p.reorder_point is not null and coalesce(s.on_hand - s.reserved, 0) <= p.reorder_point) as "lowStock"
  from products p
  left join (
    select product_id, sum(on_hand) as on_hand, sum(reserved) as reserved
    from stock_levels group by product_id
  ) s on s.product_id = p.id`;

export async function listProducts(
  ctx: Ctx,
  options: { search?: string; lowStockOnly?: boolean } = {},
): Promise<ProductSummary[]> {
  requirePermission(ctx, "product.read");
  const search = options.search?.trim() ?? "";
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<ProductSummary>(
      `select * from (${PRODUCT_SQL} where p.status = 'active') q
       where ($2 = '' or q.name ilike '%' || $2 || '%' or q.sku ilike '%' || $2 || '%')
         and (not $3 or q."lowStock")
       order by q.sku
       limit 500`,
      [can(ctx, "product.cost.view"), search, options.lowStockOnly ?? false],
    );
    return result.rows;
  });
}

export async function getProduct(ctx: Ctx, id: string): Promise<ProductSummary | null> {
  requirePermission(ctx, "product.read");
  if (!UUID.test(id)) return null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<ProductSummary>(`${PRODUCT_SQL} where p.id = $2`, [
      can(ctx, "product.cost.view"),
      id,
    ]);
    return result.rows[0] ?? null;
  });
}

export type ProductInput = {
  sku: string;
  name: string;
  category?: string;
  price: number;
  cost?: number;
  shelfLocation?: string;
  reorderPoint?: number | null;
  /** Left out, the barcode is kept as it is; blank clears it. */
  barcode?: string;
  /** Left out, a new product is taxed and an existing one keeps its setting. */
  taxable?: boolean;
};

function cleanProduct(input: ProductInput) {
  const sku = input.sku.trim();
  const name = input.name.trim();
  if (!sku) throw new ValidationError("sku", "Enter a product code.");
  if (sku.length > 60) throw new ValidationError("sku", "Keep the product code under 60 characters.");
  if (!name) throw new ValidationError("name", "Enter the product's name.");
  if (name.length > 200) throw new ValidationError("name", "Keep the name under 200 characters.");
  if (!Number.isFinite(input.price) || input.price < 0) throw new ValidationError("price", "Enter a price of zero or more.");
  if (input.cost !== undefined && (!Number.isFinite(input.cost) || input.cost < 0)) throw new ValidationError("cost", "Enter a cost of zero or more.");
  const reorder = input.reorderPoint ?? null;
  if (reorder !== null && (!Number.isFinite(reorder) || reorder < 0)) throw new ValidationError("reorderPoint", "Enter a reorder point of zero or more.");
  const barcode = input.barcode === undefined ? undefined : input.barcode.replace(/\s+/g, "") || null;
  if (barcode && !/^[A-Za-z0-9._-]{3,64}$/.test(barcode)) throw new ValidationError("barcode", "A barcode is 3 to 64 letters and digits.");
  return { barcode, sku, name, category: input.category?.trim().slice(0, 100) || null, price: input.price, cost: input.cost, shelfLocation: input.shelfLocation?.trim().slice(0, 50) || null, reorder, taxable: input.taxable };
}

const isDuplicate = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
const duplicateOf = (error: unknown, p: { sku: string; barcode?: string | null }) =>
  String((error as { constraint?: string }).constraint).includes("barcode")
    ? new ValidationError("barcode", `Another product already has the barcode ${p.barcode}.`)
    : new ValidationError("sku", `Another product already uses the code ${p.sku}.`);

export async function createProduct(ctx: Ctx, input: ProductInput): Promise<{ id: string }> {
  requirePermission(ctx, "product.write");
  const p = cleanProduct(input);
  try {
    return await withTenant(ctx.pool, ctx.orgId, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `insert into products (org_id, sku, name, category, price, cost, shelf_location, reorder_point, barcode, taxable)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [ctx.orgId, p.sku, p.name, p.category, p.price, can(ctx, "product.cost.view") ? (p.cost ?? 0) : 0, p.shelfLocation, p.reorder, p.barcode ?? null, p.taxable ?? true],
      );
      const id = created.rows[0]!.id;
      await tx.query(
        `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
         values ($1, 'user', $2, 'product.created', 'product', $3, $4)`,
        [ctx.orgId, ctx.userId, id, JSON.stringify({ sku: p.sku, name: p.name, price: p.price })],
      );
      return { id };
    });
  } catch (error) {
    if (isDuplicate(error)) throw duplicateOf(error, p);
    throw error;
  }
}

/** Cost is only changed when the role may see cost; otherwise it is left as it was. */
export async function updateProduct(ctx: Ctx, id: string, input: ProductInput): Promise<void> {
  requirePermission(ctx, "product.write");
  const p = cleanProduct(input);
  if (!UUID.test(id)) throw new ValidationError("id", "Product not found.");
  try {
    await withTenant(ctx.pool, ctx.orgId, async (tx) => {
      const snapshot = async () => (await tx.query<Record<string, unknown>>(`select sku, name, category, price::float8 as price, case when $2 then cost::float8 end as cost, shelf_location as "shelfLocation", reorder_point::float8 as "reorderPoint", barcode, taxable from products where id = $1`, [id, can(ctx, "product.cost.view")])).rows[0] ?? {};
      const was = await snapshot();
      const done = await tx.query(
        `update products set sku = $2, name = $3, category = $4, price = $5,
                cost = case when $9 then $6 else cost end,
                shelf_location = $7, reorder_point = $8,
                barcode = case when $10 then $11 else barcode end, taxable = coalesce($12, taxable), updated_at = now()
          where id = $1`,
        [id, p.sku, p.name, p.category, p.price, p.cost ?? 0, p.shelfLocation, p.reorder, can(ctx, "product.cost.view") && p.cost !== undefined, p.barcode !== undefined, p.barcode ?? null, p.taxable ?? null],
      );
      if (done.rowCount === 0) throw new ValidationError("id", "Product not found.");
      await tx.query(
        `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, before, after)
         values ($1, 'user', $2, 'product.updated', 'product', $3, $4, $5)`,
        [ctx.orgId, ctx.userId, id, JSON.stringify(was), JSON.stringify(await snapshot())],
      );
    });
  } catch (error) {
    if (isDuplicate(error)) throw duplicateOf(error, p);
    throw error;
  }
}

/** Archiving hides a product from lists and new orders. Its history stays, and it can be restored. */
export async function setProductArchived(ctx: Ctx, id: string, archived: boolean): Promise<void> {
  requirePermission(ctx, "product.write");
  if (!UUID.test(id)) throw new ValidationError("id", "Product not found.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    if (archived) {
      const busy = await tx.query<{ reserved: number; open: number }>(
        `select coalesce((select sum(reserved) from stock_levels where product_id = $1), 0)::float8 as reserved,
                (select count(*)::int from purchase_order_lines pl join purchase_orders po on po.id = pl.order_id
                  where pl.product_id = $1 and po.status in ('pending_approval', 'approved', 'sent', 'partially_received')) as open`,
        [id],
      );
      if (busy.rows[0]!.reserved > 0) throw new ValidationError("id", "This product is reserved for open orders. Ship or cancel them before archiving.");
      if (busy.rows[0]!.open > 0) throw new ValidationError("id", "This product is on an open purchase order. Receive or cancel it before archiving.");
    }
    const done = await tx.query("update products set status = $2, updated_at = now() where id = $1", [id, archived ? "archived" : "active"]);
    if (done.rowCount === 0) throw new ValidationError("id", "Product not found.");
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
       values ($1, 'user', $2, $3, 'product', $4, '{}')`,
      [ctx.orgId, ctx.userId, archived ? "product.archived" : "product.restored", id],
    );
  });
}

export async function listArchivedProducts(ctx: Ctx): Promise<ProductSummary[]> {
  requirePermission(ctx, "product.read");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<ProductSummary>(`select * from (${PRODUCT_SQL} where p.status = 'archived') q order by q.sku limit 500`, [can(ctx, "product.cost.view")]);
    return result.rows;
  });
}

export async function productStatus(ctx: Ctx, id: string): Promise<"active" | "archived" | null> {
  requirePermission(ctx, "product.read");
  if (!UUID.test(id)) return null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<{ status: "active" | "archived" }>("select status from products where id = $1", [id]);
    return result.rows[0]?.status ?? null;
  });
}

export type Lookup = { match: "barcode" | "sku" | "name" | "none"; products: ProductSummary[] };

/**
 * Finds what a scan or a typed code refers to: an exact barcode first, then an exact product
 * code, then anything whose name or code contains the text. Archived products are left out.
 */
export async function lookupProduct(ctx: Ctx, code: string): Promise<Lookup> {
  requirePermission(ctx, "product.read");
  const text = code.trim().slice(0, 100);
  if (!text) return { match: "none", products: [] };
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const seeCost = can(ctx, "product.cost.view");
    const exact = async (column: "barcode" | "sku") =>
      (await tx.query<ProductSummary>(`${PRODUCT_SQL} where p.status = 'active' and lower(p.${column}) = lower($2)`, [seeCost, column === "barcode" ? text.replace(/\s+/g, "") : text])).rows;
    const byBarcode = await exact("barcode");
    if (byBarcode.length) return { match: "barcode", products: byBarcode };
    const bySku = await exact("sku");
    if (bySku.length) return { match: "sku", products: bySku };
    const escaped = text.replace(/[\\%_]/g, "\\$&");
    const loose = await tx.query<ProductSummary>(
      `${PRODUCT_SQL} where p.status = 'active' and (p.name ilike '%' || $2 || '%' or p.sku ilike '%' || $2 || '%') order by p.sku limit 8`,
      [seeCost, escaped],
    );
    return { match: loose.rows.length ? "name" : "none", products: loose.rows };
  });
}
