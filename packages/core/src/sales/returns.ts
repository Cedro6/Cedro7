import { withTenant } from "@bos/db/runtime";
import { raiseCreditInTx } from "../billing/invoices";
import { postMovements } from "../inventory/ledger";
import type { Ctx } from "../platform/context";
import { StateError, ValidationError } from "../platform/errors";
import { featureOn } from "../platform/features";
import { can, ForbiddenError, requirePermission } from "../platform/permissions";
import { nextNumber } from "./orders";

/**
 * A customer sends goods back from an order that was shipped. One step records what came back,
 * puts it on the shelf again if it is fit to sell, and can raise a credit note for its value.
 * Nothing more than was shipped can ever be returned.
 */
export type ReturnLine = { orderLineId: string; productId: string; sku: string; name: string; qty: number; unitPrice: number };
export type OrderReturn = {
  id: string;
  number: string;
  reason: string;
  restocked: boolean;
  returnedAt: Date;
  byName: string | null;
  creditNoteNumber: string | null;
  creditAmount: number | null;
  /** Goods value before tax. */
  value: number;
  lines: ReturnLine[];
};
/** What can still come back on each line: shipped less already returned. */
export type Returnable = { orderLineId: string; productId: string; sku: string; name: string; shipped: number; returned: number; left: number; unitPrice: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cents = (n: number) => Math.round(n * 100) / 100;
const four = (n: number) => Math.round(n * 1e4) / 1e4;

function requireReturns(ctx: Ctx, write: boolean): void {
  requirePermission(ctx, write ? "sales_order.write" : "sales_order.read");
  if (!featureOn(ctx.features, "returns")) throw new ForbiddenError(write ? "sales_order.write" : "sales_order.read");
}

const RETURNABLE = `
  select l.id as "orderLineId", l.product_id as "productId", p.sku, p.name, l.qty_shipped::float8 as shipped,
         coalesce((select sum(rl.qty) from return_lines rl where rl.order_line_id = l.id), 0)::float8 as returned,
         l.unit_price::float8 as "unitPrice", l.unit_cost::float8 as "unitCost"
    from sales_order_lines l join products p on p.id = l.product_id
   where l.order_id = $1 order by l.position`;

export async function listReturnable(ctx: Ctx, orderId: string): Promise<Returnable[]> {
  requireReturns(ctx, false);
  if (!UUID.test(orderId)) return [];
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const r = await tx.query<Omit<Returnable, "left">>(RETURNABLE, [orderId]);
    return r.rows.map(({ orderLineId, productId, sku, name, shipped, returned, unitPrice }) => ({ orderLineId, productId, sku, name, shipped, returned, unitPrice, left: four(shipped - returned) }));
  });
}

export async function listReturns(ctx: Ctx, orderId: string): Promise<OrderReturn[]> {
  requireReturns(ctx, false);
  if (!UUID.test(orderId)) return [];
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const heads = await tx.query<Omit<OrderReturn, "lines" | "value">>(
      `select r.id, r.number, r.reason, r.restocked, r.returned_at as "returnedAt", u.name as "byName",
              cn.number as "creditNoteNumber", cn.amount::float8 as "creditAmount"
         from returns r left join users u on u.id = r.created_by left join credit_notes cn on cn.id = r.credit_note_id
        where r.order_id = $1 order by r.returned_at desc, r.number desc`,
      [orderId],
    );
    const lines = await tx.query<ReturnLine & { returnId: string }>(
      `select rl.return_id as "returnId", rl.order_line_id as "orderLineId", l.product_id as "productId", p.sku, p.name,
              rl.qty::float8 as qty, l.unit_price::float8 as "unitPrice"
         from return_lines rl join returns r on r.id = rl.return_id join sales_order_lines l on l.id = rl.order_line_id
         join products p on p.id = l.product_id
        where r.order_id = $1 order by l.position`,
      [orderId],
    );
    return heads.rows.map((h) => {
      const own = lines.rows.filter((l) => l.returnId === h.id).map(({ returnId: _, ...line }) => line);
      return { ...h, lines: own, value: cents(own.reduce((n, l) => n + l.qty * l.unitPrice, 0)) };
    });
  });
}

export async function createReturn(
  ctx: Ctx,
  orderId: string,
  input: { lines: { orderLineId: string; qty: number }[]; reason: string; restock: boolean; credit: boolean; idempotencyKey: string },
): Promise<{ id: string; number: string; units: number; value: number; restocked: boolean; creditNoteNumber: string | null; creditAmount: number; replayed: boolean }> {
  requireReturns(ctx, true);
  if (input.credit && !can(ctx, "invoice.write")) throw new ForbiddenError("invoice.write");
  if (!UUID.test(orderId)) throw new StateError("Order not found.");
  const reason = input.reason.trim();
  if (!reason) throw new ValidationError("reason", "Say why the goods came back.");
  if (reason.length > 200) throw new ValidationError("reason", "Keep the reason under 200 characters.");
  if (!input.idempotencyKey.trim()) throw new ValidationError("idempotencyKey", "The return could not be identified. Reload the page and try again.");
  const asked = input.lines.filter((l) => l.qty !== 0);
  if (asked.length === 0) throw new ValidationError("lines", "Enter how many came back on at least one line.");
  for (const l of asked) {
    if (!UUID.test(l.orderLineId)) throw new ValidationError("lines", "That line is not on this order.");
    if (!Number.isFinite(l.qty) || l.qty < 0 || four(l.qty) !== l.qty) throw new ValidationError("lines", "Each quantity must be above zero, with at most 4 decimal places.");
  }
  if (new Set(asked.map((l) => l.orderLineId)).size !== asked.length) throw new ValidationError("lines", "Each line can appear once.");
  const restock = input.restock && featureOn(ctx.features, "stock");

  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const order = await tx.query<{ number: string; customer_id: string; tax_rate: number }>(
      "select number, customer_id, tax_rate::float8 as tax_rate from sales_orders where id = $1 for update",
      [orderId],
    );
    const head = order.rows[0];
    if (!head) throw new StateError("Order not found.");
    const again = await tx.query<{ id: string; number: string; restocked: boolean; cn: string | null; amount: number | null }>(
      `select r.id, r.number, r.restocked, cn.number as cn, cn.amount::float8 as amount
         from returns r left join credit_notes cn on cn.id = r.credit_note_id where r.idempotency_key = $1`,
      [input.idempotencyKey],
    );
    if (again.rows[0]) {
      const a = again.rows[0];
      return { id: a.id, number: a.number, units: 0, value: 0, restocked: a.restocked, creditNoteNumber: a.cn, creditAmount: a.amount ?? 0, replayed: true };
    }
    const lines = await tx.query<Omit<Returnable, "left"> & { unitCost: number | null }>(RETURNABLE, [orderId]);
    const byId = new Map(lines.rows.map((l) => [l.orderLineId, l]));
    for (const l of asked) {
      const line = byId.get(l.orderLineId);
      if (!line) throw new ValidationError("lines", "That line is not on this order.");
      const left = four(line.shipped - line.returned);
      if (l.qty > left) {
        throw new ValidationError("lines", left <= 0 ? `Nothing more can come back for ${line.name}.` : `Only ${left} of ${line.name} can still come back.`);
      }
    }
    const number = await nextNumber(tx, ctx.orgId, "return", "RET");
    // The credit note is raised first so the return can point at it: a return is written once and never changed.
    const value = cents(asked.reduce((n, l) => n + l.qty * byId.get(l.orderLineId)!.unitPrice, 0));
    let creditNoteNumber: string | null = null;
    let creditAmount = 0;
    let creditNoteId: string | null = null;
    if (input.credit && value > 0) {
      creditAmount = cents(value + cents(value * head.tax_rate));
      // Taken off the order's oldest unpaid invoice when there is one; otherwise kept on the customer's account.
      const unpaid = await tx.query<{ id: string }>(
        `select i.id from invoices i
          where i.order_id = $1 and i.voided_at is null
            and i.amount - coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id), 0)
                         - coalesce((select sum(a.amount) from credit_applications a where a.invoice_id = i.id), 0) > 0
          order by i.issued_at limit 1`,
        [orderId],
      );
      const note = await raiseCreditInTx(tx, ctx, { customerId: head.customer_id, invoiceId: unpaid.rows[0]?.id, amount: creditAmount, reason: `Return ${number}: ${reason}`.slice(0, 200) });
      creditNoteNumber = note.number;
      creditNoteId = note.id;
    }
    const created = await tx.query<{ id: string }>(
      "insert into returns (org_id, number, order_id, reason, restocked, idempotency_key, created_by, credit_note_id) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
      [ctx.orgId, number, orderId, reason, restock, input.idempotencyKey, ctx.userId, creditNoteId],
    );
    const id = created.rows[0]!.id;
    for (const l of asked) {
      await tx.query("insert into return_lines (org_id, return_id, order_line_id, qty) values ($1, $2, $3, $4)", [ctx.orgId, id, l.orderLineId, l.qty]);
    }
    if (restock) {
      await postMovements(tx, ctx, {
        idempotencyKey: `return:${id}`,
        kind: "return_in",
        reason: `Return ${number} from ${head.number}`,
        source: { type: "return", id },
        lines: asked.map((l) => ({ productId: byId.get(l.orderLineId)!.productId, qtyDelta: l.qty, unitCost: byId.get(l.orderLineId)!.unitCost })),
      });
    }
    const units = four(asked.reduce((n, l) => n + l.qty, 0));
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after) values ($1, 'user', $2, 'return.created', 'sales_order', $3, $4)`,
      [ctx.orgId, ctx.userId, orderId, JSON.stringify({ number, units, value, restocked: restock, creditNoteNumber })],
    );
    return { id, number, units, value, restocked: restock, creditNoteNumber, creditAmount, replayed: false };
  });
}
