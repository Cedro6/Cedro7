import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "./context";
import { featureOn } from "./features";
import { can, ForbiddenError, requirePermission } from "./permissions";

/**
 * The full report: every figure for a chosen stretch of dates, each set beside the same
 * figure for a comparison stretch (the dates just before, or the same dates a year earlier).
 *
 * Sales are orders confirmed in the dates, cancelled ones left out, goods only, before tax.
 * Dates are whole days in the company's time zone and include both ends.
 */

export const ANALYSIS_PRESETS = ["this_month", "last_month", "this_quarter", "last_quarter", "30d", "90d", "ytd", "12m", "last_year", "custom"] as const;
export type AnalysisPreset = (typeof ANALYSIS_PRESETS)[number];
export const COMPARE_MODES = ["previous", "year", "none"] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];
export type DateRange = { from: string; to: string };
export type Bucket = "day" | "week" | "month";
/** A figure for the chosen dates and the comparison dates. `was` is null when nothing is compared or the role may not see it. */
export type Pair = { now: number; was: number | null };

export const isAnalysisPreset = (v: unknown): v is AnalysisPreset => (ANALYSIS_PRESETS as readonly unknown[]).includes(v);
export const isCompareMode = (v: unknown): v is CompareMode => (COMPARE_MODES as readonly unknown[]).includes(v);

const ZONE = "America/New_York";
const DAY = 86_400_000;
const at = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => iso(new Date(at(date).getTime() + n * DAY));
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(at(v).getTime()) && iso(at(v)) === v;
export const daysIn = (r: DateRange) => Math.round((at(r.to).getTime() - at(r.from).getTime()) / DAY) + 1;

/** Today's date in the company's time zone. */
export function today(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Moves a date by whole months, keeping the day where the month is long enough (Mar 31 less a month is Feb 28). */
function addMonths(date: string, n: number): string {
  const d = at(date);
  const day = d.getUTCDate();
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last))));
}

/** Turns a named period into dates. An unusable custom range falls back to the last 30 days. */
export function resolveRange(preset: AnalysisPreset, on: string, custom?: { from?: string; to?: string }): DateRange {
  const d = at(on);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const q = Math.floor(m / 3) * 3;
  const ymd = (yy: number, mm: number, dd: number) => iso(new Date(Date.UTC(yy, mm, dd)));
  switch (preset) {
    case "this_month": return { from: ymd(y, m, 1), to: on };
    case "last_month": return { from: ymd(y, m - 1, 1), to: ymd(y, m, 0) };
    case "this_quarter": return { from: ymd(y, q, 1), to: on };
    case "last_quarter": return { from: ymd(y, q - 3, 1), to: ymd(y, q, 0) };
    case "90d": return { from: addDays(on, -89), to: on };
    case "ytd": return { from: ymd(y, 0, 1), to: on };
    case "12m": return { from: addDays(addMonths(on, -12), 1), to: on };
    case "last_year": return { from: ymd(y - 1, 0, 1), to: ymd(y - 1, 11, 31) };
    case "custom":
      if (isDate(custom?.from) && isDate(custom?.to) && custom.from <= custom.to && custom.from >= "2000-01-01" && daysIn({ from: custom.from, to: custom.to }) <= 1830) {
        return { from: custom.from, to: custom.to };
      }
      return { from: addDays(on, -29), to: on };
    default: return { from: addDays(on, -29), to: on };
  }
}

/** The dates a range is compared with: the same number of days just before it, or the same dates a year earlier. */
export function compareRange(range: DateRange, mode: CompareMode): DateRange | null {
  if (mode === "none") return null;
  if (mode === "year") return { from: addMonths(range.from, -12), to: addMonths(range.to, -12) };
  const n = daysIn(range);
  return { from: addDays(range.from, -n), to: addDays(range.from, -1) };
}

const bucketFor = (days: number): Bucket => (days <= 45 ? "day" : days <= 200 ? "week" : "month");

/** Adds daily totals up into the chart's steps. Months follow the calendar; weeks are seven days from the first date. */
function intoBuckets(range: DateRange, bucket: Bucket, daily: Map<string, number>): { start: string; total: number }[] {
  const out: { start: string; total: number }[] = [];
  let key = "";
  for (let day = range.from, i = 0; day <= range.to; day = addDays(day, 1), i++) {
    const k = bucket === "day" ? day : bucket === "week" ? String(Math.floor(i / 7)) : day.slice(0, 7);
    if (k !== key) {
      out.push({ start: day, total: 0 });
      key = k;
    }
    out[out.length - 1]!.total += daily.get(day) ?? 0;
  }
  return out;
}

export type Analysis = {
  range: DateRange;
  compare: DateRange | null;
  mode: CompareMode;
  bucket: Bucket;
  sales: {
    revenue: Pair;
    orders: Pair;
    average: Pair;
    units: Pair;
    /** Customers who had an order confirmed in the dates. */
    customers: Pair;
    /** Of those, the ones whose first ever order falls in the dates. */
    newCustomers: Pair;
    /** Sales less what each product cost on the day its order was confirmed. Null when the role may not see cost. */
    margin: Pair | null;
  };
  /** One step per day, week or month. `was` lines up step for step with the comparison dates. */
  trend: { start: string; now: number; wasStart: string | null; was: number | null }[];
  /** Every product sold in either set of dates, biggest first. */
  products: { id: string; sku: string; name: string; category: string | null; units: Pair; revenue: Pair; margin: Pair | null }[];
  categories: { name: string; revenue: Pair }[];
  /** Every customer with an order in either set of dates. Empty when the role may not see customers. */
  customers: { id: string; name: string; orders: Pair; revenue: Pair; isNew: boolean }[];
  /** Sales by the person who owns the order. */
  people: { id: string | null; name: string; orders: Pair; revenue: Pair }[];
  money: {
    /** Invoices issued in the dates, voided ones left out, tax included. */
    invoiced: Pair;
    /** Payments received in the dates. */
    collected: Pair;
    /** Credit notes raised in the dates. */
    credits: Pair;
    /** Average days from invoice to payment, for payments received in the dates. Null when there were none. */
    daysToPay: { now: number | null; was: number | null };
    /** What customers owe today, by how late it is. Not tied to the dates. */
    owed: { current: number; late30: number; late60: number; older: number; total: number };
    /** Who owes the most today. */
    debtors: { id: string; name: string; owed: number; overdue: number; oldest: number }[];
  };
  /** Stock as it stands today. Null when stock is not tracked or the role may not see cost. */
  stock: {
    value: number;
    units: number;
    lowStock: number;
    /** Products on the shelf that sold nothing in the dates, most money tied up first. */
    idle: { id: string; sku: string; name: string; onHand: number; value: number }[];
    idleValue: number;
  } | null;
  /**
   * Running costs and profit. Null when bills and expenses are off or the role may not see them.
   * Costs count by the date of the bill or purchase, voided ones left out.
   */
  costs: {
    /** Everything except stock purchases. */
    running: Pair;
    /** Paid or billed for goods to resell. Not taken off profit again: the cost of goods sold covers it. */
    stockPurchases: Pair;
    categories: { name: string; amount: Pair }[];
    /** Margin less running costs. Null when the role may not see cost. */
    profit: Pair | null;
    /** Unpaid bills today. */
    owed: number;
    overdue: number;
  } | null;
  /** Null when purchasing is off or the role may not see purchase orders. */
  purchasing: {
    /** Purchase orders approved in the dates, cancelled ones left out, at ordered cost. */
    ordered: Pair;
    count: Pair;
    /** Goods received in the dates, at the purchase order's cost. */
    received: Pair;
    suppliers: { id: string; name: string; orders: Pair; ordered: Pair }[];
    /** Still to arrive today. */
    open: { count: number; value: number; late: number };
  } | null;
};

export async function analysis(ctx: Ctx, input: { range: DateRange; mode?: CompareMode }): Promise<Analysis> {
  requirePermission(ctx, "report.view");
  if (!featureOn(ctx.features, "reports")) throw new ForbiddenError("report.view");
  const { range } = input;
  if (!isDate(range.from) || !isDate(range.to) || range.from > range.to) throw new Error("Choose a start date on or before the end date");
  const mode = input.mode ?? "previous";
  const compare = compareRange(range, mode);
  const seeCost = can(ctx, "product.cost.view");
  const bucket = bucketFor(daysIn(range));
  // $1..$4 everywhere: the chosen dates, then the comparison dates (null when nothing is compared, which matches no row).
  const dates = [range.from, range.to, compare?.from ?? null, compare?.to ?? null];
  const pair = (now: number, was: number): Pair => ({ now, was: compare ? was : null });
  const local = (column: string) => `(${column} at time zone '${ZONE}')::date`;
  const NOW = (column: string) => `${local(column)} between $1::date and $2::date`;
  const WAS = (column: string) => `${local(column)} between $3::date and $4::date`;
  const EITHER = (column: string) => `(${NOW(column)} or ${WAS(column)})`;
  // One row per line of an order confirmed in either set of dates.
  const LINES = `
    select o.id as order_id, o.customer_id, o.owner_user_id, l.product_id, l.qty, l.qty * l.unit_price as amount, l.unit_cost,
           ${local("o.confirmed_at")} as day, ${NOW("o.confirmed_at")} as cur
      from sales_orders o join sales_order_lines l on l.order_id = o.id
     where o.status <> 'cancelled' and o.confirmed_at is not null and ${EITHER("o.confirmed_at")}`;

  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const totals = await tx.query<Record<"rev" | "rev0" | "orders" | "orders0" | "units" | "units0" | "cust" | "cust0" | "margin" | "margin0", number>>(
      `select coalesce(sum(x.amount) filter (where cur), 0)::float8 as rev, coalesce(sum(x.amount) filter (where not cur), 0)::float8 as rev0,
              count(distinct order_id) filter (where cur)::int as orders, count(distinct order_id) filter (where not cur)::int as orders0,
              coalesce(sum(x.qty) filter (where cur), 0)::float8 as units, coalesce(sum(x.qty) filter (where not cur), 0)::float8 as units0,
              count(distinct customer_id) filter (where cur)::int as cust, count(distinct customer_id) filter (where not cur)::int as cust0,
              coalesce(sum(x.amount - x.qty * coalesce(x.unit_cost, p.cost)) filter (where cur), 0)::float8 as margin,
              coalesce(sum(x.amount - x.qty * coalesce(x.unit_cost, p.cost)) filter (where not cur), 0)::float8 as margin0
         from (${LINES}) x join products p on p.id = x.product_id`,
      dates,
    );
    const t = totals.rows[0]!;
    const fresh = await tx.query<{ now: number; was: number }>(
      `select count(*) filter (where ${NOW("first")})::int as now, count(*) filter (where ${WAS("first")})::int as was
         from (select min(confirmed_at) as first from sales_orders
                where status <> 'cancelled' and confirmed_at is not null group by customer_id) f`,
      dates,
    );

    const daily = await tx.query<{ day: string; cur: boolean; total: number }>(
      `select to_char(day, 'YYYY-MM-DD') as day, cur, sum(amount)::float8 as total from (${LINES}) x group by day, cur`,
      dates,
    );
    const byDay = (cur: boolean) => new Map(daily.rows.filter((r) => r.cur === cur).map((r) => [r.day, r.total]));
    const nowSteps = intoBuckets(range, bucket, byDay(true));
    const wasSteps = compare ? intoBuckets(compare, bucket, byDay(false)) : [];
    const trend = nowSteps.map((s, i) => ({ start: s.start, now: s.total, wasStart: wasSteps[i]?.start ?? null, was: wasSteps[i]?.total ?? null }));

    const products = await tx.query<{ id: string; sku: string; name: string; category: string | null } & Record<"units" | "units0" | "rev" | "rev0" | "margin" | "margin0", number>>(
      `select p.id, p.sku, p.name, p.category,
              coalesce(sum(x.qty) filter (where cur), 0)::float8 as units, coalesce(sum(x.qty) filter (where not cur), 0)::float8 as units0,
              coalesce(sum(x.amount) filter (where cur), 0)::float8 as rev, coalesce(sum(x.amount) filter (where not cur), 0)::float8 as rev0,
              coalesce(sum(x.amount - x.qty * coalesce(x.unit_cost, p.cost)) filter (where cur), 0)::float8 as margin,
              coalesce(sum(x.amount - x.qty * coalesce(x.unit_cost, p.cost)) filter (where not cur), 0)::float8 as margin0
         from (${LINES}) x join products p on p.id = x.product_id
        group by p.id, p.sku, p.name, p.category order by 7 desc, 8 desc, p.sku`,
      dates,
    );
    const categories = new Map<string, Pair>();
    for (const p of products.rows) {
      const name = p.category?.trim() || "No category";
      const sum = categories.get(name) ?? pair(0, 0);
      categories.set(name, pair(sum.now + p.rev, (sum.was ?? 0) + p.rev0));
    }

    const customers = can(ctx, "customer.read")
      ? await tx.query<{ id: string; name: string; is_new: boolean } & Record<"orders" | "orders0" | "rev" | "rev0", number>>(
          `select c.id, c.name,
                  count(distinct x.order_id) filter (where cur)::int as orders, count(distinct x.order_id) filter (where not cur)::int as orders0,
                  coalesce(sum(x.amount) filter (where cur), 0)::float8 as rev, coalesce(sum(x.amount) filter (where not cur), 0)::float8 as rev0,
                  coalesce((select ${NOW("min(o.confirmed_at)")} from sales_orders o
                             where o.customer_id = c.id and o.status <> 'cancelled' and o.confirmed_at is not null), false) as is_new
             from (${LINES}) x join customers c on c.id = x.customer_id
            group by c.id, c.name order by 5 desc, 6 desc, c.name`,
          dates,
        )
      : { rows: [] };

    const people = await tx.query<{ id: string | null; name: string | null } & Record<"orders" | "orders0" | "rev" | "rev0", number>>(
      `select u.id, u.name,
              count(distinct x.order_id) filter (where cur)::int as orders, count(distinct x.order_id) filter (where not cur)::int as orders0,
              coalesce(sum(x.amount) filter (where cur), 0)::float8 as rev, coalesce(sum(x.amount) filter (where not cur), 0)::float8 as rev0
         from (${LINES}) x left join users u on u.id = x.owner_user_id
        group by u.id, u.name order by 5 desc, 6 desc, u.name`,
      dates,
    );

    const money = await tx.query<Record<"invoiced" | "invoiced0" | "collected" | "collected0" | "credits" | "credits0", number> & { days: number | null; days0: number | null }>(
      `select (select coalesce(sum(amount), 0) from invoices where voided_at is null and ${NOW("issued_at")})::float8 as invoiced,
              (select coalesce(sum(amount), 0) from invoices where voided_at is null and ${WAS("issued_at")})::float8 as invoiced0,
              (select coalesce(sum(amount), 0) from payments where ${NOW("paid_at")})::float8 as collected,
              (select coalesce(sum(amount), 0) from payments where ${WAS("paid_at")})::float8 as collected0,
              (select coalesce(sum(amount), 0) from credit_notes where ${NOW("created_at")})::float8 as credits,
              (select coalesce(sum(amount), 0) from credit_notes where ${WAS("created_at")})::float8 as credits0,
              (select avg(greatest(extract(epoch from p.paid_at - i.issued_at) / 86400, 0)) from payments p join invoices i on i.id = p.invoice_id
                where ${NOW("p.paid_at")})::float8 as days,
              (select avg(greatest(extract(epoch from p.paid_at - i.issued_at) / 86400, 0)) from payments p join invoices i on i.id = p.invoice_id
                where ${WAS("p.paid_at")})::float8 as days0`,
      dates,
    );
    const m = money.rows[0]!;
    const BALANCES = `
      select i.customer_id, (date_trunc('day', now())::date - i.due_at::date) as late,
             i.amount - coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id), 0)
                      - coalesce((select sum(a.amount) from credit_applications a where a.invoice_id = i.id), 0) as balance
        from invoices i where i.voided_at is null`;
    const owed = await tx.query<Record<"current" | "late30" | "late60" | "older", number>>(
      `select coalesce(sum(balance) filter (where late <= 0), 0)::float8 as current,
              coalesce(sum(balance) filter (where late between 1 and 30), 0)::float8 as late30,
              coalesce(sum(balance) filter (where late between 31 and 60), 0)::float8 as late60,
              coalesce(sum(balance) filter (where late > 60), 0)::float8 as older
         from (${BALANCES}) b where balance > 0`,
    );
    const debtors = can(ctx, "customer.read")
      ? await tx.query<{ id: string; name: string; owed: number; overdue: number; oldest: number }>(
          `select c.id, c.name, sum(b.balance)::float8 as owed, coalesce(sum(b.balance) filter (where b.late > 0), 0)::float8 as overdue,
                  greatest(max(b.late), 0)::int as oldest
             from (${BALANCES}) b join customers c on c.id = b.customer_id
            where b.balance > 0 group by c.id, c.name order by 3 desc, c.name limit 25`,
        )
      : { rows: [] };
    const o = owed.rows[0]!;

    let stock: Analysis["stock"] = null;
    if (featureOn(ctx.features, "stock") && seeCost) {
      const s = await tx.query<{ id: string; sku: string; name: string; on_hand: number; value: number; low: boolean; sold: boolean }>(
        `select p.id, p.sku, p.name, coalesce(s.on_hand, 0)::float8 as on_hand, (coalesce(s.on_hand, 0) * p.cost)::float8 as value,
                (p.reorder_point is not null and coalesce(s.on_hand - s.reserved, 0) <= p.reorder_point) as low,
                exists (select 1 from (${LINES}) x where x.product_id = p.id and x.cur) as sold
           from products p
           left join (select product_id, sum(on_hand) as on_hand, sum(reserved) as reserved from stock_levels group by product_id) s
                  on s.product_id = p.id
          where p.status = 'active' order by 5 desc, p.sku`,
        dates,
      );
      const idle = s.rows.filter((r) => !r.sold && r.on_hand > 0);
      stock = {
        value: s.rows.reduce((sum, r) => sum + r.value, 0),
        units: s.rows.reduce((sum, r) => sum + r.on_hand, 0),
        lowStock: s.rows.filter((r) => r.low).length,
        idle: idle.slice(0, 25).map((r) => ({ id: r.id, sku: r.sku, name: r.name, onHand: r.on_hand, value: r.value })),
        idleValue: idle.reduce((sum, r) => sum + r.value, 0),
      };
    }

    let purchasing: Analysis["purchasing"] = null;
    if (featureOn(ctx.features, "purchasing") && can(ctx, "purchase_order.read")) {
      const PO = `
        select po.id, po.supplier_id, ${NOW("po.approved_at")} as cur,
               (select coalesce(sum(round(l.qty * l.unit_cost, 2)), 0) from purchase_order_lines l where l.order_id = po.id) as value
          from purchase_orders po
         where po.status <> 'cancelled' and po.approved_at is not null and ${EITHER("po.approved_at")}`;
      const suppliers = await tx.query<{ id: string; name: string } & Record<"orders" | "orders0" | "value" | "value0", number>>(
        `select s.id, s.name, count(*) filter (where cur)::int as orders, count(*) filter (where not cur)::int as orders0,
                coalesce(sum(x.value) filter (where cur), 0)::float8 as value, coalesce(sum(x.value) filter (where not cur), 0)::float8 as value0
           from (${PO}) x join suppliers s on s.id = x.supplier_id group by s.id, s.name order by 5 desc, 6 desc, s.name`,
        dates,
      );
      const received = await tx.query<{ now: number; was: number }>(
        `select coalesce(sum(round(rl.qty * l.unit_cost, 2)) filter (where ${NOW("r.received_at")}), 0)::float8 as now,
                coalesce(sum(round(rl.qty * l.unit_cost, 2)) filter (where ${WAS("r.received_at")}), 0)::float8 as was
           from receipts r join receipt_lines rl on rl.receipt_id = r.id join purchase_order_lines l on l.id = rl.order_line_id`,
        dates,
      );
      const open = await tx.query<{ count: number; value: number; late: number }>(
        `select count(*)::int as count,
                coalesce(sum((select sum(round((l.qty - l.qty_received) * l.unit_cost, 2)) from purchase_order_lines l where l.order_id = po.id)), 0)::float8 as value,
                count(*) filter (where po.expected_on < (now() at time zone '${ZONE}')::date)::int as late
           from purchase_orders po where po.status in ('approved', 'sent', 'partially_received')`,
      );
      const sum = (key: "orders" | "orders0" | "value" | "value0") => suppliers.rows.reduce((n, r) => n + r[key], 0);
      purchasing = {
        ordered: pair(sum("value"), sum("value0")),
        count: pair(sum("orders"), sum("orders0")),
        received: pair(received.rows[0]!.now, received.rows[0]!.was),
        suppliers: suppliers.rows.map((r) => ({ id: r.id, name: r.name, orders: pair(r.orders, r.orders0), ordered: pair(r.value, r.value0) })),
        open: open.rows[0]!,
      };
    }

    let costs: Analysis["costs"] = null;
    if (can(ctx, "expense.read")) {
      const byCategory = await tx.query<{ name: string; now: number; was: number }>(
        `select category as name, coalesce(sum(amount) filter (where incurred_on between $1::date and $2::date), 0)::float8 as now,
                coalesce(sum(amount) filter (where incurred_on between $3::date and $4::date), 0)::float8 as was
           from expenses where voided_at is null and (incurred_on between $1::date and $2::date or incurred_on between $3::date and $4::date)
          group by category order by 2 desc, 3 desc, 1`,
        dates,
      );
      const unpaid = await tx.query<{ owed: number; overdue: number }>(
        `select coalesce(sum(amount), 0)::float8 as owed,
                coalesce(sum(amount) filter (where due_on < (now() at time zone '${ZONE}')::date), 0)::float8 as overdue
           from expenses where voided_at is null and paid_on is null`,
      );
      const isStock = (name: string) => name === "Stock purchases";
      const total = (key: "now" | "was", stockOnly: boolean) => byCategory.rows.filter((r) => isStock(r.name) === stockOnly).reduce((n, r) => n + r[key], 0);
      const running = pair(total("now", false), total("was", false));
      costs = {
        running,
        stockPurchases: pair(total("now", true), total("was", true)),
        categories: byCategory.rows.map((r) => ({ name: r.name, amount: pair(r.now, r.was) })),
        profit: seeCost ? pair(t.margin - running.now, t.margin0 - (running.was ?? 0)) : null,
        owed: unpaid.rows[0]!.owed,
        overdue: unpaid.rows[0]!.overdue,
      };
    }

    return {
      range,
      compare,
      mode,
      bucket,
      sales: {
        revenue: pair(t.rev, t.rev0),
        orders: pair(t.orders, t.orders0),
        average: pair(t.orders > 0 ? t.rev / t.orders : 0, t.orders0 > 0 ? t.rev0 / t.orders0 : 0),
        units: pair(t.units, t.units0),
        customers: pair(t.cust, t.cust0),
        newCustomers: pair(fresh.rows[0]!.now, fresh.rows[0]!.was),
        margin: seeCost ? pair(t.margin, t.margin0) : null,
      },
      trend,
      products: products.rows.map((p) => ({
        id: p.id, sku: p.sku, name: p.name, category: p.category,
        units: pair(p.units, p.units0), revenue: pair(p.rev, p.rev0), margin: seeCost ? pair(p.margin, p.margin0) : null,
      })),
      categories: [...categories].map(([name, revenue]) => ({ name, revenue })).sort((a, b) => b.revenue.now - a.revenue.now || a.name.localeCompare(b.name)),
      customers: customers.rows.map((c) => ({ id: c.id, name: c.name, orders: pair(c.orders, c.orders0), revenue: pair(c.rev, c.rev0), isNew: c.is_new })),
      people: people.rows.map((p) => ({ id: p.id, name: p.name ?? "No one assigned", orders: pair(p.orders, p.orders0), revenue: pair(p.rev, p.rev0) })),
      money: {
        invoiced: pair(m.invoiced, m.invoiced0),
        collected: pair(m.collected, m.collected0),
        credits: pair(m.credits, m.credits0),
        daysToPay: { now: m.days, was: compare ? m.days0 : null },
        owed: { ...o, total: o.current + o.late30 + o.late60 + o.older },
        debtors: debtors.rows,
      },
      stock,
      costs,
      purchasing,
    };
  });
}
