import { currencyOf, moneyText, zoneOf } from "./locale";
import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "./context";
import { featureOn } from "./features";
import { can } from "./permissions";

export type SalesTrend = {
  /** One entry per day, oldest first, 21 days ending today. */
  days: { date: string; total: number }[];
  /** Last 7 days including today. */
  thisWeek: number;
  /** The 7 days before that. */
  lastWeek: number;
};

export type AttentionItem = {
  kind: "low_stock" | "overdue_invoice" | "ready_to_ship" | "late_purchase_order" | "overdue_bill" | "quiet_customer" | "reminders";
  tone: "bad" | "warn" | "info";
  title: string;
  detail: string;
  href: string;
  action: string;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Value of orders confirmed on each of the last 21 days (goods only, before tax).
 * Cancelled orders are left out. Null when the role may not see sales orders.
 */
export async function salesTrend(ctx: Ctx): Promise<SalesTrend | null> {
  if (!can(ctx, "sales_order.read")) return null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<{ day: string; total: string }>(
      `with days as (
         select generate_series((now() at time zone $1)::date - 20, (now() at time zone $1)::date, interval '1 day')::date as day
       )
       select to_char(d.day, 'YYYY-MM-DD') as day,
              coalesce((select sum(l.qty * l.unit_price)
                          from sales_orders o join sales_order_lines l on l.order_id = o.id
                         where o.status <> 'cancelled' and o.confirmed_at is not null
                           and (o.confirmed_at at time zone $1)::date = d.day), 0)::text as total
         from days d order by d.day`,
      [zoneOf(ctx)],
    );
    const days = result.rows.map((r) => ({ date: r.day, total: Number(r.total) }));
    const sum = (rows: typeof days) => rows.reduce((s, r) => s + r.total, 0);
    return { days, thisWeek: sum(days.slice(-7)), lastWeek: sum(days.slice(-14, -7)) };
  });
}

/**
 * Things that need someone's attention today, worked out from the company's own
 * records. Only what the role may see and the company's features cover is listed.
 */
export async function attention(ctx: Ctx): Promise<AttentionItem[]> {
  const stock = featureOn(ctx.features, "stock");
  const purchasing = featureOn(ctx.features, "purchasing");
  const items: AttentionItem[] = [];
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    if (featureOn(ctx.features, "calendar")) {
      const mine = await tx.query<{ n: number; late: number; first: string }>(
        `select count(*)::int as n, count(*) filter (where due_on < (now() at time zone $2)::date)::int as late,
                (array_agg(title order by due_on, created_at))[1] as first
           from reminders where assigned_to = $1 and done_at is null and due_on <= (now() at time zone $2)::date`,
        [ctx.userId, zoneOf(ctx)],
      );
      const r = mine.rows[0]!;
      if (r.n > 0) {
        items.push({
          kind: "reminders",
          tone: r.late > 0 ? "warn" : "info",
          title: r.n === 1 ? r.first : `${r.n} reminders due`,
          detail: r.n === 1 ? (r.late > 0 ? "Reminder overdue" : "Reminder for today") : `${r.first}${r.late > 0 ? ` · ${r.late} overdue` : ""}`,
          href: "/calendar",
          action: "Open",
        });
      }
    }

    if (can(ctx, "sales_order.read")) {
      const overdue = await tx.query<{ n: number; owed: string; oldest: number }>(
        `select count(*)::int as n, coalesce(sum(b.balance), 0)::text as owed,
                coalesce(max(extract(day from now() - b.due_at))::int, 0) as oldest
           from (select i.due_at,
                        i.amount - coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id), 0)
                                 - coalesce((select sum(a.amount) from credit_applications a where a.invoice_id = i.id), 0) as balance
                   from invoices i
                  where i.voided_at is null and i.due_at < date_trunc('day', now())) b
          where b.balance > 0`,
      );
      const o = overdue.rows[0]!;
      if (o.n > 0) {
        items.push({
          kind: "overdue_invoice",
          tone: "bad",
          title: `${plural(o.n, "invoice", "invoices")} overdue`,
          detail: `${moneyText(Number(o.owed), currencyOf(ctx), true)} owed · oldest ${plural(o.oldest, "day", "days")} late`,
          href: "/invoices?show=overdue",
          action: "Open",
        });
      }
    }

    if (stock && can(ctx, "product.read")) {
      const low = await tx.query<{ name: string; available: string; reorder_point: string }>(
        `select p.name,
                coalesce((select sum(on_hand - reserved) from stock_levels s where s.product_id = p.id), 0)::text as available,
                p.reorder_point::text as reorder_point
           from products p
          where p.status = 'active' and p.reorder_point is not null
            and coalesce((select sum(on_hand - reserved) from stock_levels s where s.product_id = p.id), 0) <= p.reorder_point
          order by coalesce((select sum(on_hand - reserved) from stock_levels s where s.product_id = p.id), 0) - p.reorder_point, p.name`,
      );
      if (low.rows.length > 0) {
        const first = low.rows[0]!;
        const out = Number(first.available) <= 0;
        items.push({
          kind: "low_stock",
          tone: out ? "bad" : "warn",
          title: out ? `${first.name} is out of stock` : `${first.name} is running low`,
          detail:
            `${Number(first.available)} left, reorder at ${Number(first.reorder_point)}` +
            (low.rows.length > 1 ? ` · ${plural(low.rows.length - 1, "other product", "other products")} low` : ""),
          href: "/products?low=1",
          action: "Review",
        });
      }
    }

    if (stock && can(ctx, "sales_order.read")) {
      const ready = await tx.query<{ number: string; waiting: number }>(
        `select o.number, extract(day from now() - o.confirmed_at)::int as waiting
           from sales_orders o
          where o.status in ('confirmed', 'partially_shipped')
            and exists (select 1 from sales_order_lines l where l.order_id = o.id and l.qty_reserved > 0)
          order by o.confirmed_at`,
      );
      if (ready.rows.length > 0) {
        const oldest = ready.rows[0]!.waiting;
        items.push({
          kind: "ready_to_ship",
          tone: oldest >= 2 ? "warn" : "info",
          title: `${plural(ready.rows.length, "order", "orders")} ready to ship`,
          detail:
            ready.rows.slice(0, 3).map((r) => r.number).join(" · ") +
            (oldest >= 1 ? ` · waiting ${plural(oldest, "day", "days")}` : ""),
          href: "/sales?show=open",
          action: "Open",
        });
      }
    }

    if (purchasing && can(ctx, "purchase_order.read")) {
      const late = await tx.query<{ number: string; supplier: string; late: number; n: number }>(
        `select po.number, s.name as supplier, ((now() at time zone $1)::date - po.expected_on)::int as late,
                count(*) over ()::int as n
           from purchase_orders po join suppliers s on s.id = po.supplier_id
          where po.status in ('approved', 'sent', 'partially_received')
            and po.expected_on < (now() at time zone $1)::date
          order by po.expected_on limit 1`,
        [zoneOf(ctx)],
      );
      const p = late.rows[0];
      if (p) {
        items.push({
          kind: "late_purchase_order",
          tone: "warn",
          title: `${p.supplier} is ${plural(p.late, "day", "days")} late`,
          detail: p.number + (p.n > 1 ? ` · ${plural(p.n - 1, "other late order", "other late orders")}` : ""),
          href: "/purchasing?show=open",
          action: "Open",
        });
      }
    }

    if (can(ctx, "expense.read")) {
      const bills = await tx.query<{ n: number; owed: string; oldest: number }>(
        `select count(*)::int as n, coalesce(sum((amount - coalesce((select sum(p.amount) from expense_payments p where p.expense_id = expenses.id), 0))), 0)::text as owed,
                coalesce(max((now() at time zone $1)::date - due_on), 0)::int as oldest
           from expenses where voided_at is null and paid_on is null and due_on < (now() at time zone $1)::date`,
        [zoneOf(ctx)],
      );
      const b = bills.rows[0]!;
      if (b.n > 0) {
        items.push({
          kind: "overdue_bill",
          tone: "warn",
          title: `${plural(b.n, "bill", "bills")} to pay overdue`,
          detail: `${moneyText(Number(b.owed), currencyOf(ctx), true)} owed · oldest ${plural(b.oldest, "day", "days")} late`,
          href: "/bills",
          action: "Open",
        });
      }
    }

    if (can(ctx, "customer.read") && can(ctx, "sales_order.read")) {
      const quiet = await tx.query<{ id: string; name: string; quiet: number }>(
        `select c.id, c.name, extract(day from now() - max(o.created_at))::int as quiet
           from customers c join sales_orders o on o.customer_id = c.id and o.status <> 'cancelled'
          where c.status = 'active'
          group by c.id, c.name
         having max(o.created_at) < now() - interval '30 days'
          order by max(o.created_at) limit 1`,
      );
      const q = quiet.rows[0];
      if (q) {
        items.push({
          kind: "quiet_customer",
          tone: "info",
          title: `${q.name} quiet for ${q.quiet} days`,
          detail: "No orders in over a month",
          href: `/customers/${q.id}`,
          action: "Open",
        });
      }
    }
  });
  return items;
}
