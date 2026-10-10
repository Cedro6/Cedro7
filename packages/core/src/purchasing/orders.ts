import { withTenant, type PoolClient } from "@bos/db/runtime";
import { postMovements } from "../inventory/ledger";
import type { Ctx } from "../platform/context";
import { StateError, ValidationError } from "../platform/errors";
import { can, requirePermission } from "../platform/permissions";
import { allocateBackordersInTx, lockBackorderedOrdersInTx } from "../sales/orders";

/**
 * Purchasing. A purchase order goes draft -> approved (directly when its total
 * is within the company's approval limit, otherwise through pending approval)
 * -> sent -> received. Receiving posts the stock ledger, updates average cost
 * and reserves the new stock for waiting sales orders, all in one transaction.
 */

export type PurchaseOrderStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "sent"
  | "partially_received"
  | "received"
  | "cancelled";

export type Supplier = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  paymentTerms: string | null;
  leadTimeDays: number | null;
};

export type PurchaseOrderSummary = {
  id: string;
  number: string;
  status: PurchaseOrderStatus;
  supplierId: string;
  supplierName: string;
  expectedOn: string | null;
  createdAt: Date;
  /** Null when the role may not see cost. */
  total: number | null;
  unitsOrdered: number;
  unitsReceived: number;
};

export type PurchaseOrderLine = {
  id: string;
  productId: string;
  sku: string;
  name: string;
  qty: number;
  /** Null when the role may not see cost. */
  unitCost: number | null;
  amount: number | null;
  received: number;
  outstanding: number;
};

export type Receipt = { id: string; number: string; receivedAt: Date; receivedBy: string | null; units: number };

export type PurchaseOrderDetail = PurchaseOrderSummary & {
  notes: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  sentAt: Date | null;
  cancelledAt: Date | null;
  approvalLimit: number;
  lines: PurchaseOrderLine[];
  receipts: Receipt[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;

const SUMMARY_SQL = `
  select o.id, o.number, o.status, o.supplier_id as "supplierId", s.name as "supplierName",
         to_char(o.expected_on, 'YYYY-MM-DD') as "expectedOn", o.created_at as "createdAt",
         t.total::float8 as total, t.units_ordered::float8 as "unitsOrdered",
         t.units_received::float8 as "unitsReceived",
         o.notes, cu.name as "createdBy", au.name as "approvedBy", o.approved_at as "approvedAt",
         o.sent_at as "sentAt", o.cancelled_at as "cancelledAt",
         (select po_approval_threshold::float8 from organizations) as "approvalLimit"
  from purchase_orders o
  join suppliers s on s.id = o.supplier_id
  left join users cu on cu.id = o.created_by
  left join users au on au.id = o.approved_by
  join lateral (
    select coalesce(sum(round(l.qty * l.unit_cost, 2)), 0) as total,
           coalesce(sum(l.qty), 0) as units_ordered,
           coalesce(sum(l.qty_received), 0) as units_received
    from purchase_order_lines l where l.order_id = o.id
  ) t on true`;

async function nextNumber(tx: PoolClient, orgId: string, docType: string, prefix: string): Promise<string> {
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
     values ($1, 'user', $2, $3, 'purchase_order', $4, $5)`,
    [ctx.orgId, ctx.userId, action, orderId, JSON.stringify(after)],
  );
}

type Locked = { status: PurchaseOrderStatus; number: string; total: number; received: number };

async function lockOrder(tx: PoolClient, orderId: string): Promise<Locked> {
  if (!UUID.test(orderId)) throw new StateError("Purchase order not found.");
  const order = await tx.query<{ status: PurchaseOrderStatus; number: string }>(
    "select status, number from purchase_orders where id = $1 for update",
    [orderId],
  );
  const row = order.rows[0];
  if (!row) throw new StateError("Purchase order not found.");
  const totals = await tx.query<{ total: number; received: number }>(
    `select coalesce(sum(round(qty * unit_cost, 2)), 0)::float8 as total,
            coalesce(sum(qty_received), 0)::float8 as received
     from purchase_order_lines where order_id = $1`,
    [orderId],
  );
  return { ...row, ...totals.rows[0]! };
}

export async function listSuppliers(ctx: Ctx): Promise<Supplier[]> {
  requirePermission(ctx, "purchase_order.read");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<Supplier>(
      `select id, name, email, phone, payment_terms as "paymentTerms", lead_time_days as "leadTimeDays"
       from suppliers where status = 'active' order by lower(name) limit 500`,
    );
    return result.rows;
  });
}

export async function createSupplier(
  ctx: Ctx,
  input: { name: string; email?: string; phone?: string; paymentTerms?: string; leadTimeDays?: number },
): Promise<{ id: string }> {
  requirePermission(ctx, "purchase_order.write");
  const name = input.name.trim();
  if (!name) throw new ValidationError("name", "Enter the supplier's name.");
  if (name.length > 200) throw new ValidationError("name", "Keep the name under 200 characters.");
  const lead = input.leadTimeDays;
  if (lead !== undefined && (!Number.isInteger(lead) || lead < 0 || lead > 730)) {
    throw new ValidationError("leadTimeDays", "Lead time must be a whole number of days.");
  }
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const created = await tx.query<{ id: string }>(
      `insert into suppliers (org_id, name, email, phone, payment_terms, lead_time_days)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        ctx.orgId,
        name,
        input.email?.trim().slice(0, 200) || null,
        input.phone?.trim().slice(0, 50) || null,
        input.paymentTerms?.trim().slice(0, 50) || null,
        lead ?? null,
      ],
    );
    const id = created.rows[0]!.id;
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
       values ($1, 'user', $2, 'supplier.created', 'supplier', $3, $4)`,
      [ctx.orgId, ctx.userId, id, JSON.stringify({ name })],
    );
    return { id };
  });
}

export async function createPurchaseOrder(
  ctx: Ctx,
  input: {
    supplierId: string;
    lines: { productId: string; qty: number; unitCost?: number }[];
    expectedOn?: string;
    notes?: string;
  },
): Promise<{ id: string; number: string }> {
  requirePermission(ctx, "purchase_order.write");
  if (!UUID.test(input.supplierId)) throw new ValidationError("supplierId", "Choose a supplier.");
  if (input.lines.length === 0) throw new ValidationError("lines", "Add at least one product.");
  if (input.lines.length > 200) throw new ValidationError("lines", "A purchase order can have at most 200 lines.");
  for (const line of input.lines) {
    if (!UUID.test(line.productId)) throw new ValidationError("lines", "Choose a product on every line.");
    if (!Number.isFinite(line.qty) || line.qty <= 0 || line.qty > 1e9 || round4(line.qty) !== line.qty) {
      throw new ValidationError("lines", "Each quantity must be greater than zero, with at most 4 decimal places.");
    }
    if (line.unitCost !== undefined && (!Number.isFinite(line.unitCost) || line.unitCost < 0 || line.unitCost > 1e12)) {
      throw new ValidationError("lines", "A cost cannot be negative.");
    }
  }
  const expectedOn = input.expectedOn?.trim() || null;
  if (expectedOn && (!DATE.test(expectedOn) || Number.isNaN(Date.parse(expectedOn)))) {
    throw new ValidationError("expectedOn", "Enter the expected date as a calendar date.");
  }
  const notes = input.notes?.trim() || null;
  if (notes && notes.length > 2000) throw new ValidationError("notes", "Keep notes under 2,000 characters.");

  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const supplier = await tx.query("select 1 from suppliers where id = $1 and status = 'active'", [input.supplierId]);
    if (supplier.rowCount === 0) throw new ValidationError("supplierId", "Choose a supplier.");
    const productIds = [...new Set(input.lines.map((line) => line.productId))];
    const products = await tx.query<{ id: string; cost: number }>(
      "select id, cost::float8 as cost from products where id = any($1::uuid[]) and status = 'active'",
      [productIds],
    );
    if (products.rowCount !== productIds.length) throw new ValidationError("lines", "Choose a product on every line.");
    const cost = new Map(products.rows.map((row) => [row.id, row.cost]));

    const number = await nextNumber(tx, ctx.orgId, "purchase_order", "PO");
    const order = await tx.query<{ id: string }>(
      `insert into purchase_orders (org_id, number, supplier_id, expected_on, notes, created_by)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [ctx.orgId, number, input.supplierId, expectedOn, notes, ctx.userId],
    );
    const id = order.rows[0]!.id;
    for (const [index, line] of input.lines.entries()) {
      await tx.query(
        `insert into purchase_order_lines (org_id, order_id, position, product_id, qty, unit_cost)
         values ($1, $2, $3, $4, $5, $6)`,
        [ctx.orgId, id, index + 1, line.productId, line.qty, line.unitCost ?? cost.get(line.productId)!],
      );
    }
    await audit(tx, ctx, "purchase_order.created", id, { number, lines: input.lines.length });
    return { id, number };
  });
}

/**
 * Submits a draft. A total within the company's approval limit is approved on
 * the spot; anything larger waits for someone who may approve.
 */
export async function submitPurchaseOrder(ctx: Ctx, orderId: string): Promise<{ status: PurchaseOrderStatus }> {
  requirePermission(ctx, "purchase_order.write");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.status !== "draft") throw new StateError("Only a draft can be submitted.");
    const limit = (await tx.query<{ v: number }>("select po_approval_threshold::float8 as v from organizations")).rows[0]!.v;
    const auto = order.total <= limit || can(ctx, "purchase_order.approve");
    const status: PurchaseOrderStatus = auto ? "approved" : "pending_approval";
    await tx.query(
      `update purchase_orders
       set status = $1, updated_at = now(),
           approved_by = case when $2 then $3::uuid end, approved_at = case when $2 then now() end
       where id = $4`,
      [status, auto, ctx.userId, orderId],
    );
    await audit(tx, ctx, auto ? "purchase_order.approved" : "purchase_order.submitted", orderId, {
      total: order.total,
      limit,
      automatic: auto && !can(ctx, "purchase_order.approve"),
    });
    return { status };
  });
}

export async function approvePurchaseOrder(ctx: Ctx, orderId: string): Promise<void> {
  requirePermission(ctx, "purchase_order.approve");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.status !== "pending_approval") throw new StateError("This purchase order is not waiting for approval.");
    await tx.query(
      "update purchase_orders set status = 'approved', approved_by = $1, approved_at = now(), updated_at = now() where id = $2",
      [ctx.userId, orderId],
    );
    await audit(tx, ctx, "purchase_order.approved", orderId, { total: order.total, automatic: false });
  });
}

/** Records that the approved order went to the supplier. Sending the email itself is not built yet. */
export async function markPurchaseOrderSent(ctx: Ctx, orderId: string): Promise<void> {
  requirePermission(ctx, "purchase_order.write");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.status !== "approved") throw new StateError("Only an approved purchase order can be marked as sent.");
    await tx.query("update purchase_orders set status = 'sent', sent_at = now(), updated_at = now() where id = $1", [
      orderId,
    ]);
    await audit(tx, ctx, "purchase_order.sent", orderId, {});
  });
}

export async function cancelPurchaseOrder(ctx: Ctx, orderId: string): Promise<void> {
  requirePermission(ctx, "purchase_order.write");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.status === "cancelled") return;
    if (order.received > 0 || order.status === "received" || order.status === "partially_received") {
      throw new StateError("A purchase order with received stock cannot be cancelled.");
    }
    await tx.query(
      "update purchase_orders set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = $1",
      [orderId],
    );
    await audit(tx, ctx, "purchase_order.cancelled", orderId, {});
  });
}

/**
 * Receives stock against an approved or sent purchase order. In one transaction:
 * records the receipt, posts ledger entries, updates each product's moving
 * average cost, and reserves the new stock for waiting sales orders.
 */
export async function receivePurchaseOrder(
  ctx: Ctx,
  orderId: string,
  input: { idempotencyKey: string; lines: { lineId: string; qty: number }[] },
): Promise<{ receiptNumber: string; units: number; allocatedToBackorders: number; replayed: boolean }> {
  requirePermission(ctx, "purchase_order.receive");
  if (!input.idempotencyKey.trim()) throw new ValidationError("idempotencyKey", "A request id is required.");
  const wanted = input.lines.filter((line) => line.qty !== 0);
  for (const line of wanted) {
    if (!UUID.test(line.lineId)) throw new ValidationError("lines", "Unknown line.");
    if (!Number.isFinite(line.qty) || line.qty < 0 || round4(line.qty) !== line.qty) {
      throw new ValidationError("lines", "Each quantity must be zero or more, with at most 4 decimal places.");
    }
  }
  if (new Set(wanted.map((line) => line.lineId)).size !== wanted.length) {
    throw new ValidationError("lines", "Each line can appear once per receipt.");
  }

  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const order = await lockOrder(tx, orderId);
    const earlier = await tx.query<{ number: string; units: number }>(
      `select r.number, coalesce(sum(l.qty), 0)::float8 as units
       from receipts r left join receipt_lines l on l.receipt_id = r.id
       where r.idempotency_key = $1 group by r.number`,
      [input.idempotencyKey],
    );
    if (earlier.rows[0]) {
      return { receiptNumber: earlier.rows[0].number, units: earlier.rows[0].units, allocatedToBackorders: 0, replayed: true };
    }
    if (!["approved", "sent", "partially_received"].includes(order.status)) {
      throw new StateError("Stock can only be received against an approved purchase order.");
    }
    if (wanted.length === 0) throw new ValidationError("lines", "Enter a quantity to receive.");

    const lines = await tx.query<{ id: string; product_id: string; unit_cost: number; outstanding: number }>(
      `select id, product_id, unit_cost::float8 as unit_cost, (qty - qty_received)::float8 as outstanding
       from purchase_order_lines where order_id = $1`,
      [orderId],
    );
    const byId = new Map(lines.rows.map((row) => [row.id, row]));
    const receiving = wanted.map((line) => {
      const row = byId.get(line.lineId);
      if (!row) throw new ValidationError("lines", "Unknown line.");
      if (line.qty > row.outstanding) {
        throw new ValidationError("lines", `Only ${row.outstanding} are still outstanding on one of these lines.`);
      }
      return { ...row, qty: line.qty };
    });
    const productIds = [...new Set(receiving.map((line) => line.product_id))];

    // Sales orders are locked before stock, the same order every sales action uses.
    const waitingOrders = await lockBackorderedOrdersInTx(tx, productIds);

    const receiptNumber = await nextNumber(tx, ctx.orgId, "receipt", "RC");
    const receipt = await tx.query<{ id: string }>(
      `insert into receipts (org_id, number, order_id, idempotency_key, received_by)
       values ($1, $2, $3, $4, $5) returning id`,
      [ctx.orgId, receiptNumber, orderId, input.idempotencyKey, ctx.userId],
    );
    const receiptId = receipt.rows[0]!.id;

    await postMovements(tx, ctx, {
      idempotencyKey: `receipt:${receiptId}`,
      kind: "receipt",
      lines: receiving.map((line) => ({ productId: line.product_id, qtyDelta: line.qty, unitCost: line.unit_cost })),
      source: { type: "receipt", id: receiptId },
    });

    let units = 0;
    const perProduct = new Map<string, { qty: number; value: number }>();
    for (const line of receiving) {
      units = round4(units + line.qty);
      await tx.query("insert into receipt_lines (org_id, receipt_id, order_line_id, qty) values ($1, $2, $3, $4)", [
        ctx.orgId,
        receiptId,
        line.id,
        line.qty,
      ]);
      await tx.query("update purchase_order_lines set qty_received = qty_received + $1 where id = $2", [line.qty, line.id]);
      const sum = perProduct.get(line.product_id) ?? { qty: 0, value: 0 };
      perProduct.set(line.product_id, { qty: sum.qty + line.qty, value: sum.value + line.qty * line.unit_cost });
    }

    // Moving average cost. The balance rows are locked by the posting above, so on-hand cannot change under us.
    for (const [productId, received] of perProduct) {
      await tx.query(
        `update products p
         set cost = case when s.on_hand - $2 <= 0 then round(($3::numeric / $2::numeric), 4)
                         else round(((s.on_hand - $2) * p.cost + $3) / s.on_hand, 4) end,
             updated_at = now()
         from (select sum(on_hand) as on_hand from stock_levels where product_id = $1) s
         where p.id = $1 and s.on_hand > 0`,
        [productId, received.qty, received.value],
      );
    }

    const allocatedToBackorders = await allocateBackordersInTx(tx, ctx, waitingOrders, productIds);

    const open = await tx.query("select 1 from purchase_order_lines where order_id = $1 and qty_received < qty limit 1", [
      orderId,
    ]);
    const status: PurchaseOrderStatus = open.rowCount ? "partially_received" : "received";
    await tx.query("update purchase_orders set status = $1, updated_at = now() where id = $2", [status, orderId]);
    await audit(tx, ctx, "purchase_order.received", orderId, { receiptNumber, units, status, allocatedToBackorders });
    return { receiptNumber, units, allocatedToBackorders, replayed: false };
  });
}

export async function listPurchaseOrders(
  ctx: Ctx,
  options: { status?: PurchaseOrderStatus | "open" } = {},
): Promise<PurchaseOrderSummary[]> {
  requirePermission(ctx, "purchase_order.read");
  const statuses =
    options.status === "open"
      ? ["pending_approval", "approved", "sent", "partially_received"]
      : options.status
        ? [options.status]
        : null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<PurchaseOrderSummary>(
      `${SUMMARY_SQL}
       where ($1::text[] is null or o.status = any($1))
       order by o.created_at desc, o.number desc
       limit 200`,
      [statuses],
    );
    const showCost = can(ctx, "product.cost.view");
    return showCost ? result.rows : result.rows.map((row) => ({ ...row, total: null }));
  });
}

export async function getPurchaseOrder(ctx: Ctx, orderId: string): Promise<PurchaseOrderDetail | null> {
  requirePermission(ctx, "purchase_order.read");
  if (!UUID.test(orderId)) return null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const header = await tx.query<Omit<PurchaseOrderDetail, "lines" | "receipts">>(`${SUMMARY_SQL} where o.id = $1`, [
      orderId,
    ]);
    const order = header.rows[0];
    if (!order) return null;
    const lines = await tx.query<PurchaseOrderLine>(
      `select l.id, l.product_id as "productId", p.sku, p.name, l.qty::float8 as qty,
              l.unit_cost::float8 as "unitCost", round(l.qty * l.unit_cost, 2)::float8 as amount,
              l.qty_received::float8 as received, (l.qty - l.qty_received)::float8 as outstanding
       from purchase_order_lines l join products p on p.id = l.product_id
       where l.order_id = $1 order by l.position`,
      [orderId],
    );
    const receipts = await tx.query<Receipt>(
      `select r.id, r.number, r.received_at as "receivedAt", u.name as "receivedBy",
              coalesce(sum(l.qty), 0)::float8 as units
       from receipts r
       left join receipt_lines l on l.receipt_id = r.id
       left join users u on u.id = r.received_by
       where r.order_id = $1
       group by r.id, r.number, r.received_at, u.name
       order by r.received_at desc`,
      [orderId],
    );
    if (!can(ctx, "product.cost.view")) {
      return {
        ...order,
        total: null,
        lines: lines.rows.map((line) => ({ ...line, unitCost: null, amount: null })),
        receipts: receipts.rows,
      };
    }
    return { ...order, lines: lines.rows, receipts: receipts.rows };
  });
}
