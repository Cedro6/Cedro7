import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "./context";
import { can } from "./permissions";

export type Overview = {
  customers: number | null;
  products: number | null;
  team: number;
  /** Products whose available stock is at or below their reorder point. */
  lowStock: number | null;
  /** Confirmed orders not yet fully shipped. */
  openOrders: number | null;
  /** Open orders with reserved stock waiting to ship. */
  readyToShip: number | null;
  /** Purchase orders approved or sent and not yet fully received. */
  openPurchaseOrders: number | null;
  /** Invoices past their due date with a balance. */
  overdueInvoices: number | null;
};

/** Counts for the Home screen. A count the role may not see comes back as null. */
export async function overview(ctx: Ctx): Promise<Overview> {
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<{ customers: number; products: number; team: number; low_stock: number; open_orders: number; ready: number; open_pos: number; overdue: number }>(
      `select (select count(*)::int from customers where status = 'active') as customers,
              (select count(*)::int from products where status = 'active') as products,
              (select count(*)::int from memberships where status = 'active') as team,
              (select count(*)::int from products p
                 where p.status = 'active' and p.reorder_point is not null
                   and coalesce((select sum(on_hand - reserved) from stock_levels s where s.product_id = p.id), 0)
                       <= p.reorder_point) as low_stock,
              (select count(*)::int from sales_orders
                 where status in ('confirmed', 'partially_shipped')) as open_orders,
              (select count(*)::int from sales_orders o
                 where o.status in ('confirmed', 'partially_shipped')
                   and exists (select 1 from sales_order_lines l
                               where l.order_id = o.id and l.qty_reserved > 0)) as ready,
              (select count(*)::int from purchase_orders
                 where status in ('pending_approval', 'approved', 'sent', 'partially_received')) as open_pos,
              (select count(*)::int from invoices i
                 where i.voided_at is null and i.due_at < date_trunc('day', now())
                   and i.amount > coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id), 0)
                                + coalesce((select sum(a.amount) from credit_applications a where a.invoice_id = i.id), 0)) as overdue`,
    );
    const row = result.rows[0]!;
    return {
      customers: can(ctx, "customer.read") ? row.customers : null,
      products: can(ctx, "product.read") ? row.products : null,
      team: row.team,
      lowStock: can(ctx, "product.read") ? row.low_stock : null,
      openOrders: can(ctx, "sales_order.read") ? row.open_orders : null,
      readyToShip: can(ctx, "sales_order.read") ? row.ready : null,
      openPurchaseOrders: can(ctx, "purchase_order.read") ? row.open_pos : null,
      overdueInvoices: can(ctx, "sales_order.read") ? row.overdue : null,
    };
  });
}
