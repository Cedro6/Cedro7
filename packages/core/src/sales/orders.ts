import { randomUUID } from "node:crypto";
import { withTenant, type PoolClient } from "@bos/db/runtime";
import { invoiceShipmentInTx } from "../billing/invoices";
import { releaseForSourcesInTx, reserveLinesInTx, shipReservedInTx } from "../inventory/ledger";
import type { Ctx } from "../platform/context";
import { StateError, ValidationError } from "../platform/errors";
import { featureOn } from "../platform/features";
import { requirePermission } from "../platform/permissions";
import { customerPricesInTx } from "./pricing";

/**
 * Sales orders. Every function that changes an order locks the order row first
 * and stock balances second, so two actions on the same order run one after the
 * other and never deadlock with each other.
 */

export type OrderStatus = "quote" | "confirmed" | "partially_shipped" | "shipped" | "cancelled";

export type OrderSummary = {
  id: string;
  number: string;
  status: OrderStatus;
  customerId: string;
  customerName: string;
  createdAt: Date;
  total: number;
  unitsOrdered: number;
  unitsShipped: number;
  unitsReserved: number;
};

export type OrderLine = {
  id: string;
  productId: string;
  sku: string;
  name: string;
  qty: number;
  /** What the customer pays per unit, after any discount. */
  unitPrice: number;
  /** False when this line is not charged tax. */
  taxable: boolean;
  /** The price the line started from: the customer's price, or one typed in. */
  listPrice: number;
  discountPercent: number;
  amount: number;
  reserved: number;
  shipped: number;
  /** Ordered but neither reserved nor shipped. */
  backorder: number;
  /** Stock free to reserve right now. */
  availableNow: number;
};

export type Shipment = { id: string; number: string; shippedAt: Date; shippedBy: string | null; units: number };

export type OrderDetail = OrderSummary & {
  taxRate: number;
  subtotal: number;
  tax: number;
  notes: string | null;
  ownerName: string | null;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  unitsBackordered: number;
  lines: OrderLine[];
  shipments: Shipment[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUMMARY_SQL = `
  select o.id, o.number, o.status, o.customer_id as "customerId", c.name as "customerName",
         o.created_at as "createdAt",
         (t.subtotal + round(t.taxable * o.tax_rate, 2))::float8 as total,
         t.units_ordered::float8 as "unitsOrdered",
         t.units_shipped::float8 as "unitsShipped",
         t.units_reserved::float8 as "unitsReserved",
         o.tax_rate::float8 as "taxRate", t.subtotal::float8 as subtotal,
         round(t.taxable * o.tax_rate, 2)::float8 as tax,
         o.notes, u.name as "ownerName", o.confirmed_at as "confirmedAt", o.cancelled_at as "cancelledAt"
  from sales_orders o
  join customers c on c.id = o.customer_id
  left join users u on u.id = o.owner_user_id
  join lateral (
    select coalesce(sum(round(l.qty * l.unit_price, 2)), 0) as subtotal,
           coalesce(sum(round(l.qty * l.unit_price, 2)) filter (where l.taxable), 0) as taxable,
           coalesce(sum(l.qty), 0) as units_ordered,
           coalesce(sum(l.qty_shipped), 0) as units_shipped,
           coalesce(sum(l.qty_reserved), 0) as units_reserved
    from sales_order_lines l where l.order_id = o.id
  ) t on true`;

export async function nextNumber(tx: PoolClient, orgId: string, docType: string, prefix: string): Promise<string> {
  const result = await tx.query<{ n: number }>(
    `insert into document_counters (org_id, doc_type, last_number) values ($1, $2, 1)
     on conflict (org_id, doc_type) do update set last_number = document_counters.last_number + 1
     returning last_number as n`,
    [orgId, docType],
  );
  return `${prefix}-${String(result.rows[0]!.n).padStart(6, "0")}`;
}

async function audit(tx: PoolClient, ctx: Ctx, action: string, orderId: string, after: unknown): Promise<void> {
  await tx.query(
    `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
     values ($1, 'user', $2, $3, 'sales_order', $4, $5)`,
    [ctx.orgId, ctx.userId, action, orderId, JSON.stringify(after)],
  );
}

type LockedLine = { id: string; product_id: string; qty: number; qty_reserved: number; qty_shipped: number };

/** Locks the order row, then returns it with its lines. Null when the order is not this company's. */
async function lockOrder(
  tx: PoolClient,
  orderId: string,
): Promise<{ status: OrderStatus; number: string; lines: LockedLine[] } | null> {
  if (!UUID.test(orderId)) return null;
  const order = await tx.query<{ status: OrderStatus; number: string }>(
    "select status, number from sales_orders where id = $1 for update",
    [orderId],
  );
  const row = order.rows[0];
  if (!row) return null;
  const lines = await tx.query<LockedLine>(
    `select id, product_id, qty::float8 as qty, qty_reserved::float8 as qty_reserved, qty_shipped::float8 as qty_shipped
     from sales_order_lines where order_id = $1 order by position`,
    [orderId],
  );
  return { ...row, lines: lines.rows };
}

function fourDecimals(value: number): boolean {
  return Math.round(value * 1e4) === value * 1e4;
}

export async function createQuote(
  ctx: Ctx,
  input: {
    customerId: string;
    lines: { productId: string; qty: number; unitPrice?: number; discountPercent?: number }[];
    taxRatePercent?: number;
    notes?: string;
  },
): Promise<{ id: string; number: string }> {
  requirePermission(ctx, "sales_order.write");
  if (!UUID.test(input.customerId)) throw new ValidationError("customerId", "Choose a customer.");
  if (input.lines.length === 0) throw new ValidationError("lines", "Add at least one product.");
  if (input.lines.length > 200) throw new ValidationError("lines", "An order can have at most 200 lines.");
  for (const line of input.lines) {
    if (!UUID.test(line.productId)) throw new ValidationError("lines", "Choose a product on every line.");
    if (!Number.isFinite(line.qty) || line.qty <= 0 || line.qty > 1e9 || !fourDecimals(line.qty)) {
      throw new ValidationError("lines", "Each quantity must be greater than zero, with at most 4 decimal places.");
    }
    if (line.unitPrice !== undefined && (!Number.isFinite(line.unitPrice) || line.unitPrice < 0 || line.unitPrice > 1e12)) {
      throw new ValidationError("lines", "A price cannot be negative.");
    }
    const discount = line.discountPercent ?? 0;
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
      throw new ValidationError("lines", "A discount must be between 0 and 100 percent.");
    }
  }
  // Left out, the tax is the company's usual rate, or nothing for a customer marked as not charged tax.
  const givenTax = input.taxRatePercent;
  if (givenTax !== undefined && (!Number.isFinite(givenTax) || givenTax < 0 || givenTax >= 100)) {
    throw new ValidationError("taxRatePercent", "Tax must be between 0 and 100 percent.");
  }
  const notes = input.notes?.trim() || null;
  if (notes && notes.length > 2000) throw new ValidationError("notes", "Keep notes under 2,000 characters.");

  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const customer = await tx.query("select 1 from customers where id = $1 and status = 'active'", [input.customerId]);
    if (customer.rowCount === 0) throw new ValidationError("customerId", "Choose a customer.");
    const taxPercent = givenTax ?? (await tx.query<{ tax: number }>(
        "select case when c.tax_exempt then 0 else o.default_tax_percent end::float8 as tax from customers c, organizations o where c.id = $1 and o.id = $2",
        [input.customerId, ctx.orgId],
      )).rows[0]?.tax ?? 0;
    const productIds = [...new Set(input.lines.map((line) => line.productId))];
    // The customer's own prices: a price list's special price or percentage, else the product's price.
    const price = await customerPricesInTx(tx, input.customerId, productIds);
    if (price.size !== productIds.length) throw new ValidationError("lines", "Choose a product on every line.");

    const untaxed = new Set((await tx.query<{ id: string }>("select id from products where id = any($1::uuid[]) and not taxable", [productIds])).rows.map((r) => r.id));
    const number = await nextNumber(tx, ctx.orgId, "sales_order", "SO");
    const order = await tx.query<{ id: string }>(
      `insert into sales_orders (org_id, number, customer_id, tax_rate, notes, owner_user_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $6) returning id`,
      [ctx.orgId, number, input.customerId, taxPercent / 100, notes, ctx.userId],
    );
    const id = order.rows[0]!.id;
    for (const [index, line] of input.lines.entries()) {
      const listPrice = line.unitPrice ?? price.get(line.productId)!;
      const discount = Math.round((line.discountPercent ?? 0) * 100) / 100;
      const net = Math.round(listPrice * (100 - discount)) / 100;
      await tx.query(
        `insert into sales_order_lines (org_id, order_id, position, product_id, qty, unit_price, list_price, discount_pct, taxable)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [ctx.orgId, id, index + 1, line.productId, line.qty, net, listPrice, discount, !untaxed.has(line.productId)],
      );
    }
    await audit(tx, ctx, "sales_order.created", id, { number, lines: input.lines.length });
    return { id, number };
  });
}

/** Reserves what is free for every line still short, and records it on the lines. */
async function reserveOutstanding(tx: PoolClient, ctx: Ctx, lines: LockedLine[]): Promise<number> {
  const short = lines
    .map((line) => ({ line, outstanding: Math.round((line.qty - line.qty_reserved - line.qty_shipped) * 1e4) / 1e4 }))
    .filter((entry) => entry.outstanding > 0);
  const results = await reserveLinesInTx(
    tx,
    ctx,
    short.map(({ line, outstanding }) => ({
      productId: line.product_id,
      qty: outstanding,
      source: { type: "sales_order_line", id: line.id },
      idempotencyKey: `so-line:${line.id}:${randomUUID()}`,
    })),
    { partial: true },
  );
  let total = 0;
  for (const [index, result] of results.entries()) {
    if (result.reserved <= 0) continue;
    total += result.reserved;
    await tx.query("update sales_order_lines set qty_reserved = qty_reserved + $1 where id = $2", [
      result.reserved,
      short[index]!.line.id,
    ]);
  }
  return total;
}

/**
 * Locks every open sales order that has a backorder for one of these products.
 * Call this BEFORE touching stock balances, so the lock order (orders, then
 * stock) matches every other order action.
 */
export async function lockBackorderedOrdersInTx(tx: PoolClient, productIds: string[]): Promise<string[]> {
  if (productIds.length === 0) return [];
  const orders = await tx.query<{ id: string }>(
    `select o.id from sales_orders o
     where o.status in ('confirmed', 'partially_shipped')
       and exists (select 1 from sales_order_lines l
                   where l.order_id = o.id and l.product_id = any($1::uuid[])
                     and l.qty - l.qty_reserved - l.qty_shipped > 0)
     order by o.id
     for update of o`,
    [productIds],
  );
  return orders.rows.map((row) => row.id);
}

/** Reserves free stock for the backordered lines of already-locked orders, oldest confirmed order first. */
export async function allocateBackordersInTx(
  tx: PoolClient,
  ctx: Ctx,
  orderIds: string[],
  productIds: string[],
): Promise<number> {
  if (orderIds.length === 0 || !featureOn(ctx.features, "stock")) return 0;
  const lines = await tx.query<LockedLine>(
    `select l.id, l.product_id, l.qty::float8 as qty, l.qty_reserved::float8 as qty_reserved,
            l.qty_shipped::float8 as qty_shipped
     from sales_order_lines l join sales_orders o on o.id = l.order_id
     where o.id = any($1::uuid[]) and l.product_id = any($2::uuid[])
       and l.qty - l.qty_reserved - l.qty_shipped > 0
     order by o.confirmed_at, o.number, l.position`,
    [orderIds, productIds],
  );
  return reserveOutstanding(tx, ctx, lines.rows);
}

/**
 * Turns a quote into an order. With stock tracked it reserves what is available and the rest is on
 * backorder. A business that does not track stock reserves nothing: the order is simply ready to complete.
 */
export async function confirmOrder(ctx: Ctx, orderId: string): Promise<{ reserved: number }> {
  requirePermission(ctx, "sales_order.write");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw new StateError("Order not found.");
    if (order.status !== "quote") throw new StateError("Only a quote can be confirmed.");
    const reserved = featureOn(ctx.features, "stock") ? await reserveOutstanding(tx, ctx, order.lines) : 0;
    await tx.query(
      "update sales_orders set status = 'confirmed', confirmed_at = now(), updated_at = now() where id = $1",
      [orderId],
    );
    // The cost of each line is fixed now, so later cost changes do not rewrite this order's margin.
    await tx.query(
      "update sales_order_lines l set unit_cost = p.cost from products p where p.id = l.product_id and l.order_id = $1",
      [orderId],
    );
    await audit(tx, ctx, "sales_order.confirmed", orderId, { reserved });
    return { reserved };
  });
}

/** Reserves newly available stock for an open order's backordered lines. */
export async function reserveAvailable(ctx: Ctx, orderId: string): Promise<{ reserved: number }> {
  requirePermission(ctx, "sales_order.write");
  if (!featureOn(ctx.features, "stock")) throw new StateError("This business does not track stock.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw new StateError("Order not found.");
    if (order.status !== "confirmed" && order.status !== "partially_shipped") {
      throw new StateError("Stock can only be reserved for an open order.");
    }
    const reserved = await reserveOutstanding(tx, ctx, order.lines);
    if (reserved > 0) {
      await tx.query("update sales_orders set updated_at = now() where id = $1", [orderId]);
      await audit(tx, ctx, "sales_order.reserved", orderId, { reserved });
    }
    return { reserved };
  });
}

/**
 * Ships everything currently reserved for the order as one shipment.
 *
 * A business that does not track stock completes the order instead: everything still outstanding is
 * marked as delivered in one step, and no stock is moved. The same record is kept either way, so the
 * invoice that follows has one thing to point at.
 */
export async function shipOrder(
  ctx: Ctx,
  orderId: string,
  input: { idempotencyKey: string },
): Promise<{ shipmentNumber: string; units: number; replayed: boolean; invoice: { number: string; amount: number } | null }> {
  requirePermission(ctx, "sales_order.ship");
  if (!input.idempotencyKey.trim()) throw new ValidationError("idempotencyKey", "A request id is required.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw new StateError("Order not found.");
    const earlier = await tx.query<{ number: string; units: number }>(
      `select s.number, coalesce(sum(l.qty), 0)::float8 as units
       from shipments s left join shipment_lines l on l.shipment_id = s.id
       where s.idempotency_key = $1 group by s.number`,
      [input.idempotencyKey],
    );
    if (earlier.rows[0]) {
      return { shipmentNumber: earlier.rows[0].number, units: earlier.rows[0].units, replayed: true, invoice: null };
    }
    if (order.status !== "confirmed" && order.status !== "partially_shipped") {
      throw new StateError("Only a confirmed order can be shipped.");
    }
    const tracked = featureOn(ctx.features, "stock");
    if (!tracked) {
      // Stock may have been reserved before tracking was switched off. Hand it back first.
      const releasedBy = await releaseForSourcesInTx(
        tx,
        ctx,
        order.lines.filter((line) => line.qty_reserved > 0).map((line) => line.id),
      );
      for (const [lineId, qty] of releasedBy) {
        await tx.query("update sales_order_lines set qty_reserved = qty_reserved - $1 where id = $2", [qty, lineId]);
      }
    }
    const ready = tracked
      ? order.lines.filter((line) => line.qty_reserved > 0)
      : order.lines
          .map((line) => ({ ...line, qty_reserved: Math.round((line.qty - line.qty_shipped) * 1e4) / 1e4 }))
          .filter((line) => line.qty_reserved > 0);
    if (ready.length === 0) throw new StateError(tracked ? "Nothing is reserved to ship yet." : "This order is already complete.");

    const shipmentNumber = await nextNumber(tx, ctx.orgId, "shipment", "SH");
    const shipment = await tx.query<{ id: string }>(
      `insert into shipments (org_id, number, order_id, idempotency_key, shipped_by)
       values ($1, $2, $3, $4, $5) returning id`,
      [ctx.orgId, shipmentNumber, orderId, input.idempotencyKey, ctx.userId],
    );
    const shipmentId = shipment.rows[0]!.id;
    if (tracked) {
      await shipReservedInTx(tx, ctx, {
        idempotencyKey: shipmentId,
        source: { type: "shipment", id: shipmentId },
        lines: ready.map((line) => ({ productId: line.product_id, qty: line.qty_reserved, reservedFor: line.id })),
      });
    }
    let units = 0;
    for (const line of ready) {
      units += line.qty_reserved;
      await tx.query(
        "insert into shipment_lines (org_id, shipment_id, order_line_id, qty) values ($1, $2, $3, $4)",
        [ctx.orgId, shipmentId, line.id, line.qty_reserved],
      );
      await tx.query("update sales_order_lines set qty_shipped = qty_shipped + $2, qty_reserved = 0 where id = $1", [
        line.id,
        line.qty_reserved,
      ]);
    }
    const open = await tx.query("select 1 from sales_order_lines where order_id = $1 and qty_shipped < qty limit 1", [
      orderId,
    ]);
    const status: OrderStatus = open.rowCount ? "partially_shipped" : "shipped";
    await tx.query("update sales_orders set status = $1, updated_at = now() where id = $2", [status, orderId]);
    // The invoice is raised in the same transaction: there is never a shipment without one.
    const invoice = await invoiceShipmentInTx(tx, ctx, {
      orderId,
      shipmentId,
      lines: ready.map((line) => ({ orderLineId: line.id, qty: line.qty_reserved })),
    });
    await audit(tx, ctx, tracked ? "sales_order.shipped" : "sales_order.completed", orderId, { shipmentNumber, units, status, invoice: invoice.number });
    return { shipmentNumber, units, replayed: false, invoice: { number: invoice.number, amount: invoice.amount } };
  });
}

/** Cancels a quote or an order that has not shipped anything, returning its reserved stock. */
export async function cancelOrder(ctx: Ctx, orderId: string): Promise<{ released: number }> {
  requirePermission(ctx, "sales_order.write");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw new StateError("Order not found.");
    if (order.status === "cancelled") return { released: 0 };
    if (order.status !== "quote" && order.status !== "confirmed") {
      throw new StateError("An order that has shipped cannot be cancelled. Record a return instead.");
    }
    const releasedBy = await releaseForSourcesInTx(
      tx,
      ctx,
      order.lines.map((line) => line.id),
    );
    let released = 0;
    for (const [lineId, qty] of releasedBy) {
      released += qty;
      await tx.query("update sales_order_lines set qty_reserved = qty_reserved - $1 where id = $2", [qty, lineId]);
    }
    await tx.query(
      "update sales_orders set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = $1",
      [orderId],
    );
    await audit(tx, ctx, "sales_order.cancelled", orderId, { released });
    return { released };
  });
}

export async function listOrders(
  ctx: Ctx,
  options: { status?: OrderStatus | "open"; customerId?: string } = {},
): Promise<OrderSummary[]> {
  requirePermission(ctx, "sales_order.read");
  if (options.customerId && !UUID.test(options.customerId)) return [];
  const statuses =
    options.status === "open" ? ["confirmed", "partially_shipped"] : options.status ? [options.status] : null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<OrderSummary>(
      `${SUMMARY_SQL}
       where ($1::text[] is null or o.status = any($1)) and ($2::uuid is null or o.customer_id = $2)
       order by o.created_at desc, o.number desc
       limit 200`,
      [statuses, options.customerId ?? null],
    );
    return result.rows;
  });
}

export async function getOrder(ctx: Ctx, orderId: string): Promise<OrderDetail | null> {
  requirePermission(ctx, "sales_order.read");
  if (!UUID.test(orderId)) return null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const header = await tx.query<Omit<OrderDetail, "lines" | "shipments" | "unitsBackordered">>(
      `${SUMMARY_SQL} where o.id = $1`,
      [orderId],
    );
    const order = header.rows[0];
    if (!order) return null;
    const lines = await tx.query<OrderLine>(
      `select l.id, l.product_id as "productId", p.sku, p.name,
              l.qty::float8 as qty, l.unit_price::float8 as "unitPrice", l.taxable,
              l.list_price::float8 as "listPrice", l.discount_pct::float8 as "discountPercent",
              round(l.qty * l.unit_price, 2)::float8 as amount,
              l.qty_reserved::float8 as reserved, l.qty_shipped::float8 as shipped,
              (l.qty - l.qty_reserved - l.qty_shipped)::float8 as backorder,
              coalesce((select sum(s.on_hand - s.reserved) from stock_levels s
                        where s.product_id = l.product_id), 0)::float8 as "availableNow"
       from sales_order_lines l join products p on p.id = l.product_id
       where l.order_id = $1 order by l.position`,
      [orderId],
    );
    const shipments = await tx.query<Shipment>(
      `select s.id, s.number, s.shipped_at as "shippedAt", u.name as "shippedBy",
              coalesce(sum(l.qty), 0)::float8 as units
       from shipments s
       left join shipment_lines l on l.shipment_id = s.id
       left join users u on u.id = s.shipped_by
       where s.order_id = $1
       group by s.id, s.number, s.shipped_at, u.name
       order by s.shipped_at desc`,
      [orderId],
    );
    const open = order.status === "confirmed" || order.status === "partially_shipped";
    return {
      ...order,
      unitsBackordered: open ? lines.rows.reduce((sum, line) => sum + line.backorder, 0) : 0,
      lines: lines.rows,
      shipments: shipments.rows,
    };
  });
}

export type PackingSlip = {
  shipmentNumber: string;
  shippedAt: Date;
  orderId: string;
  orderNumber: string;
  customerName: string;
  /** Where the goods go: the customer's shipping address, or their billing address if they have only one. */
  shipTo: string | null;
  lines: { sku: string; name: string; qty: number; ordered: number }[];
};

/** What went out on one shipment, for the slip that goes in the box. No prices. */
export async function getPackingSlip(ctx: Ctx, shipmentId: string): Promise<PackingSlip | null> {
  requirePermission(ctx, "sales_order.read");
  if (!UUID.test(shipmentId)) return null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const head = await tx.query<Omit<PackingSlip, "lines">>(
      `select s.number as "shipmentNumber", s.shipped_at as "shippedAt", o.id as "orderId", o.number as "orderNumber",
              c.name as "customerName", coalesce(c.shipping_address, c.billing_address) as "shipTo"
         from shipments s join sales_orders o on o.id = s.order_id join customers c on c.id = o.customer_id
        where s.id = $1`,
      [shipmentId],
    );
    if (!head.rows[0]) return null;
    const lines = await tx.query<PackingSlip["lines"][number]>(
      `select p.sku, p.name, sl.qty::float8 as qty, ol.qty::float8 as ordered
         from shipment_lines sl join sales_order_lines ol on ol.id = sl.order_line_id join products p on p.id = ol.product_id
        where sl.shipment_id = $1 order by ol.position`,
      [shipmentId],
    );
    return { ...head.rows[0], lines: lines.rows };
  });
}
