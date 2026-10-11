import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "./context";
import { featureOn } from "./features";
import { can, ForbiddenError, requirePermission } from "./permissions";

export const REPORT_PERIODS = [30, 90, 365] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export type Report = {
  days: ReportPeriod;
  /** Orders confirmed in the period, cancelled ones left out. Money is goods only, before tax. */
  sales: { orders: number; revenue: number; average: number; previousRevenue: number };
  /** Revenue per calendar month, oldest first, covering the period. */
  byMonth: { month: string; revenue: number; orders: number }[];
  /** Margin is null when the role may not see cost. */
  topProducts: { id: string; sku: string; name: string; units: number; revenue: number; margin: number | null }[];
  topCustomers: { id: string; name: string; orders: number; revenue: number }[];
  /** What customers owe today, by how late it is. Not tied to the period. */
  receivables: { current: number; late30: number; late60: number; older: number; total: number };
  /** Null when stock is not tracked or the role may not see cost. */
  stock: { value: number; units: number; lowStock: number } | null;
  /** Null when purchasing is off or the role may not see purchase orders. */
  purchasing: { open: number; value: number; late: number } | null;
};

const ZONE = "America/New_York";

export function isReportPeriod(value: number): value is ReportPeriod {
  return (REPORT_PERIODS as readonly number[]).includes(value);
}

export async function report(ctx: Ctx, days: ReportPeriod = 30): Promise<Report> {
  requirePermission(ctx, "report.view");
  if (!featureOn(ctx.features, "reports")) throw new ForbiddenError("report.view");
  const seeCost = can(ctx, "product.cost.view");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    // One row per order line confirmed in this period or the one before it.
    const LINES = `
      select o.id as order_id, o.customer_id, o.confirmed_at, l.product_id, l.qty, l.qty * l.unit_price as amount
        from sales_orders o join sales_order_lines l on l.order_id = o.id
       where o.status <> 'cancelled' and o.confirmed_at is not null`;
    const sales = await tx.query<{ orders: number; revenue: number; previous: number }>(
      `select count(distinct order_id) filter (where confirmed_at >= now() - make_interval(days => $1))::int as orders,
              coalesce(sum(amount) filter (where confirmed_at >= now() - make_interval(days => $1)), 0)::float8 as revenue,
              coalesce(sum(amount) filter (where confirmed_at < now() - make_interval(days => $1)), 0)::float8 as previous
         from (${LINES}) x where confirmed_at >= now() - make_interval(days => $1 * 2)`,
      [days],
    );
    const byMonth = await tx.query<{ month: string; revenue: number; orders: number }>(
      `with months as (
         select generate_series(date_trunc('month', (now() at time zone $2) - make_interval(days => $1)),
                                date_trunc('month', now() at time zone $2), interval '1 month') as m)
       select to_char(m, 'YYYY-MM') as month,
              coalesce((select sum(amount) from (${LINES}) x
                         where date_trunc('month', x.confirmed_at at time zone $2) = m
                           and x.confirmed_at >= now() - make_interval(days => $1)), 0)::float8 as revenue,
              (select count(distinct order_id) from (${LINES}) x
                where date_trunc('month', x.confirmed_at at time zone $2) = m
                  and x.confirmed_at >= now() - make_interval(days => $1))::int as orders
         from months order by m`,
      [days, ZONE],
    );
    const topProducts = await tx.query<{ id: string; sku: string; name: string; units: number; revenue: number; margin: number | null }>(
      `select p.id, p.sku, p.name, sum(x.qty)::float8 as units, sum(x.amount)::float8 as revenue,
              case when $2 then (sum(x.amount) - sum(x.qty * p.cost))::float8 end as margin
         from (${LINES}) x join products p on p.id = x.product_id
        where x.confirmed_at >= now() - make_interval(days => $1)
        group by p.id, p.sku, p.name order by sum(x.amount) desc, p.sku limit 8`,
      [days, seeCost],
    );
    const topCustomers = can(ctx, "customer.read")
      ? await tx.query<{ id: string; name: string; orders: number; revenue: number }>(
          `select c.id, c.name, count(distinct x.order_id)::int as orders, sum(x.amount)::float8 as revenue
             from (${LINES}) x join customers c on c.id = x.customer_id
            where x.confirmed_at >= now() - make_interval(days => $1)
            group by c.id, c.name order by sum(x.amount) desc, c.name limit 8`,
          [days],
        )
      : { rows: [] };
    const owed = await tx.query<{ current: number; late30: number; late60: number; older: number }>(
      `select coalesce(sum(balance) filter (where late <= 0), 0)::float8 as current,
              coalesce(sum(balance) filter (where late between 1 and 30), 0)::float8 as late30,
              coalesce(sum(balance) filter (where late between 31 and 60), 0)::float8 as late60,
              coalesce(sum(balance) filter (where late > 60), 0)::float8 as older
         from (select (date_trunc('day', now())::date - i.due_at::date) as late,
                      i.amount - coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id), 0)
                               - coalesce((select sum(a.amount) from credit_applications a where a.invoice_id = i.id), 0) as balance
                 from invoices i where i.voided_at is null) b
        where balance > 0`,
    );
    const r = owed.rows[0]!;

    let stock: Report["stock"] = null;
    if (featureOn(ctx.features, "stock") && seeCost) {
      const s = await tx.query<{ value: number; units: number; low: number }>(
        `select coalesce(sum(coalesce(s.on_hand, 0) * p.cost), 0)::float8 as value,
                coalesce(sum(coalesce(s.on_hand, 0)), 0)::float8 as units,
                count(*) filter (where p.reorder_point is not null and coalesce(s.on_hand - s.reserved, 0) <= p.reorder_point)::int as low
           from products p
           left join (select product_id, sum(on_hand) as on_hand, sum(reserved) as reserved from stock_levels group by product_id) s
                  on s.product_id = p.id
          where p.status = 'active'`,
      );
      stock = { value: s.rows[0]!.value, units: s.rows[0]!.units, lowStock: s.rows[0]!.low };
    }

    let purchasing: Report["purchasing"] = null;
    if (featureOn(ctx.features, "purchasing") && can(ctx, "purchase_order.read")) {
      const p = await tx.query<{ open: number; value: number; late: number }>(
        `select count(*)::int as open,
                coalesce(sum((select sum(round((l.qty - l.qty_received) * l.unit_cost, 2)) from purchase_order_lines l where l.order_id = po.id)), 0)::float8 as value,
                count(*) filter (where po.expected_on < (now() at time zone $1)::date)::int as late
           from purchase_orders po where po.status in ('approved', 'sent', 'partially_received')`,
        [ZONE],
      );
      purchasing = p.rows[0]!;
    }

    const s = sales.rows[0]!;
    return {
      days,
      sales: { orders: s.orders, revenue: s.revenue, average: s.orders > 0 ? s.revenue / s.orders : 0, previousRevenue: s.previous },
      byMonth: byMonth.rows,
      topProducts: topProducts.rows,
      topCustomers: topCustomers.rows,
      receivables: { ...r, total: r.current + r.late30 + r.late60 + r.older },
      stock,
      purchasing,
    };
  });
}
