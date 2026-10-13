import { zoneOf } from "./locale";
import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "./context";
import { ValidationError } from "./errors";
import { featureOn, type BusinessType } from "./features";
import { can } from "./permissions";

/** Every card that can go on Home. */
export const WIDGETS = [
  "hero", "tiles", "sales", "invoices", "attention", "today", "top-products", "top-customers",
  "calendar", "heatmap", "ship", "low-stock", "putaway", "quotes",
  // Dealer Terminal cards. Only a dealer company can have these, and a dealer company only these and the calendar cards.
  "lot-tiles", "dealer-sales", "dealer-deals", "lot-attention", "open-deals", "newest-cars", "aged-cars",
] as const;
export type WidgetId = (typeof WIDGETS)[number];
export const isWidget = (value: string): value is WidgetId => (WIDGETS as readonly string[]).includes(value);

/** Whether this person, in this company, may have a card. A card never shows what its screens would not. */
export function widgetAllowed(ctx: Ctx, id: WidgetId): boolean {
  const on = (feature: Parameters<typeof featureOn>[1]) => featureOn(ctx.features, feature);
  const dealer = on("dealer");
  switch (id) {
    case "lot-tiles":
    case "dealer-sales":
    case "dealer-deals":
    case "lot-attention":
    case "open-deals":
    case "newest-cars":
    case "aged-cars":
      return dealer && can(ctx, "vehicle.read");
    case "today":
    case "calendar":
      return on("calendar");
  }
  if (dealer) return false;
  switch (id) {
    case "hero":
    case "sales":
    case "top-products":
      return can(ctx, "report.view") && can(ctx, "sales_order.read");
    case "top-customers":
      return can(ctx, "report.view") && can(ctx, "sales_order.read") && can(ctx, "customer.read");
    case "tiles":
    case "attention":
      return true;
    case "invoices":
    case "quotes":
    case "heatmap":
      return can(ctx, "sales_order.read");
    case "ship":
      return on("stock") && can(ctx, "sales_order.read");
    case "low-stock":
      return on("stock") && can(ctx, "product.read");
    case "putaway":
      return on("stock") && on("putaway") && can(ctx, "purchase_order.receive");
  }
}

const DEFAULT_HOME: WidgetId[] = ["hero", "tiles", "sales", "invoices", "attention", "today", "top-products"];
/** Each kind of business starts with the cards it usually needs; the rest are one tap away. */
const HOME_BY_TYPE: Partial<Record<BusinessType, WidgetId[]>> = {
  retail: ["hero", "tiles", "sales", "low-stock", "attention", "today", "top-products"],
  warehouse: ["tiles", "ship", "putaway", "attention", "low-stock", "today"],
  sales: ["hero", "tiles", "sales", "quotes", "attention", "today", "top-customers"],
  contractor: ["hero", "tiles", "sales", "quotes", "attention", "invoices", "top-customers"],
  dealer: ["lot-tiles", "dealer-sales", "dealer-deals", "newest-cars", "lot-attention", "aged-cars", "today"],
};
export const defaultHome = (type: BusinessType | undefined): WidgetId[] => (type && HOME_BY_TYPE[type]) || DEFAULT_HOME;

export type HomeLayout = { widgets: WidgetId[]; customized: boolean; available: WidgetId[] };

/** The cards this person sees, in order, and the ones they could still add. */
export async function getHomeLayout(ctx: Ctx, type: BusinessType | undefined): Promise<HomeLayout> {
  const saved = await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<{ widgets: string[] }>("select widgets from home_layouts where user_id = $1", [ctx.userId]);
    return result.rows[0]?.widgets ?? null;
  });
  const chosen = (saved ?? defaultHome(type)).filter(isWidget);
  const widgets = [...new Set(chosen)].filter((id) => widgetAllowed(ctx, id));
  return { widgets, customized: saved !== null, available: WIDGETS.filter((id) => widgetAllowed(ctx, id) && !widgets.includes(id)) };
}

async function save(ctx: Ctx, widgets: WidgetId[]): Promise<void> {
  await withTenant(ctx.pool, ctx.orgId, (tx) =>
    tx.query(
      `insert into home_layouts (org_id, user_id, widgets) values ($1, $2, $3)
       on conflict (org_id, user_id) do update set widgets = excluded.widgets, updated_at = now()`,
      [ctx.orgId, ctx.userId, widgets],
    ),
  );
}

export type HomeChange =
  | { kind: "add"; id: string }
  | { kind: "remove"; id: string }
  | { kind: "move"; id: string; by: -1 | 1 }
  | { kind: "replace"; id: string; with: string }
  | { kind: "reset" };

/** Changes this person's own Home screen. Other people's layouts are untouched. */
export async function changeHomeLayout(ctx: Ctx, type: BusinessType | undefined, change: HomeChange): Promise<void> {
  if (change.kind === "reset") {
    await withTenant(ctx.pool, ctx.orgId, (tx) => tx.query("delete from home_layouts where user_id = $1", [ctx.userId]));
    return;
  }
  const list = [...(await getHomeLayout(ctx, type)).widgets];
  const at = list.indexOf(change.id as WidgetId);
  const wanted = change.kind === "add" ? change.id : change.kind === "replace" ? change.with : null;
  if (wanted !== null) {
    if (!isWidget(wanted) || !widgetAllowed(ctx, wanted)) throw new ValidationError("id", "That card is not available to you.");
    if (list.includes(wanted)) throw new ValidationError("id", "That card is already on your Home screen.");
  }
  if (change.kind === "add") list.push(change.id as WidgetId);
  else if (at < 0) throw new ValidationError("id", "That card is not on your Home screen.");
  else if (change.kind === "remove") list.splice(at, 1);
  else if (change.kind === "replace") list[at] = change.with as WidgetId;
  else {
    const to = at + change.by;
    if (to < 0 || to >= list.length) return;
    [list[at], list[to]] = [list[to]!, list[at]!];
  }
  await save(ctx, list);
}

/** Orders confirmed and not cancelled, one row per line, with the goods value before tax. */
const LINES = `
  select o.id as order_id, o.confirmed_at, o.created_at, l.product_id, l.qty * l.unit_price as amount
    from sales_orders o join sales_order_lines l on l.order_id = o.id
   where o.status <> 'cancelled' and o.confirmed_at is not null`;

export const HERO_RANGES = [7, 30, 60] as const;
export type HeroRange = (typeof HERO_RANGES)[number];
export type Hero = {
  days: HeroRange;
  total: number;
  /** Percent change on the same number of days before. Null when there were no sales then. */
  change: number | null;
  /** What customers still owe. Null when the role may not see it. */
  toCollect: number | null;
  /** The two biggest categories and "Other", by share of sales in the period. */
  categories: { name: string; amount: number; share: number }[];
  from: string;
  to: string;
};

export async function heroFigures(ctx: Ctx, days: HeroRange): Promise<Hero | null> {
  if (!widgetAllowed(ctx, "hero")) return null;
  const series = (await dailySales(ctx, days * 2))!;
  const sum = (rows: typeof series) => rows.reduce((n, r) => n + r.total, 0);
  const total = sum(series.slice(-days));
  const before = sum(series.slice(0, days));
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const cats = await tx.query<{ name: string; amount: number }>(
      `select coalesce(nullif(trim(p.category), ''), 'Uncategorized') as name, sum(x.amount)::float8 as amount
         from (${LINES}) x join products p on p.id = x.product_id
        where (x.confirmed_at at time zone $2)::date > (now() at time zone $2)::date - $1::int::int
        group by 1 order by 2 desc`,
      [days, zoneOf(ctx)],
    );
    const top = cats.rows.slice(0, 2);
    const rest = cats.rows.slice(2).reduce((sum, c) => sum + c.amount, 0);
    const blocks = [...top, ...(rest > 0 ? [{ name: "Other", amount: rest }] : [])];
    let toCollect: number | null = null;
    if (can(ctx, "invoice.write")) {
      const owed = await tx.query<{ owed: number }>(
        `select coalesce(sum(greatest(i.amount - coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id), 0)
                                             - coalesce((select sum(a.amount) from credit_applications a where a.invoice_id = i.id), 0), 0)), 0)::float8 as owed
           from invoices i where i.voided_at is null`,
      );
      toCollect = owed.rows[0]!.owed;
    }
    return {
      days,
      total,
      change: before > 0 ? ((total - before) / before) * 100 : null,
      toCollect,
      categories: blocks.map((c) => ({ name: c.name, amount: c.amount, share: total > 0 ? c.amount / total : 0 })),
      from: series[days]!.date,
      to: series.at(-1)!.date,
    };
  });
}

/** Goods value of orders confirmed on each of the last N days, oldest first. */
export async function dailySales(ctx: Ctx, days: number): Promise<{ date: string; total: number }[] | null> {
  if (!can(ctx, "sales_order.read")) return null;
  const span = Math.min(Math.max(Math.floor(days), 1), 120);
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<{ date: string; total: number }>(
      `with d as (select generate_series((now() at time zone $2)::date - ($1::int - 1), (now() at time zone $2)::date, interval '1 day')::date as day)
       select to_char(d.day, 'YYYY-MM-DD') as date,
              coalesce((select sum(x.amount) from (${LINES}) x where (x.confirmed_at at time zone $2)::date = d.day), 0)::float8 as total
         from d order by d.day`,
      [span, zoneOf(ctx)],
    );
    return result.rows;
  });
}

export type Heatmap = { hours: number[]; /** grid[hour index][weekday, Monday first] */ grid: number[][]; busiest: number };

/** When orders are placed, by weekday and working hour, over the last 60 days. */
export async function orderHeatmap(ctx: Ctx): Promise<Heatmap | null> {
  if (!can(ctx, "sales_order.read")) return null;
  const hours = [8, 9, 10, 11, 12, 13, 14, 15, 16];
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<{ dow: number; hour: number; n: number }>(
      `select (extract(isodow from created_at at time zone $1)::int - 1) as dow,
              extract(hour from created_at at time zone $1)::int as hour, count(*)::int as n
         from sales_orders where status <> 'cancelled' and created_at > now() - interval '60 days'
        group by 1, 2`,
      [zoneOf(ctx)],
    );
    const grid = hours.map(() => Array<number>(7).fill(0));
    for (const row of result.rows) {
      const r = hours.indexOf(row.hour);
      if (r >= 0) grid[r]![row.dow] = row.n;
    }
    return { hours, grid, busiest: Math.max(0, ...grid.flat()) };
  });
}

export type Headline = {
  /** Null entries are ones this person does not get. */
  salesThisWeek: { total: number; lastWeek: number; change: number | null; spark: number[] } | null;
  readyToShip: { orders: number; units: number; open: number } | null;
  openOrders: { count: number; value: number } | null;
  openQuotes: { count: number; value: number } | null;
  unpaid: { amount: number; count: number; overdue: number } | null;
  deliveries: number | null;
  lowStock: { count: number; onOrder: number } | null;
};

/** The headline numbers. Which ones appear follows the mock-up: stock businesses see shipping, others see quotes. */
export async function headline(ctx: Ctx): Promise<Headline> {
  const stock = featureOn(ctx.features, "stock");
  const seeOrders = can(ctx, "sales_order.read");
  const series = can(ctx, "report.view") ? await dailySales(ctx, 30) : null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const out: Headline = { salesThisWeek: null, readyToShip: null, openOrders: null, openQuotes: null, unpaid: null, deliveries: null, lowStock: null };
    if (series) {
      const sum = (rows: typeof series) => rows.reduce((s, r) => s + r.total, 0);
      const total = sum(series.slice(-7));
      const lastWeek = sum(series.slice(-14, -7));
      out.salesThisWeek = { total, lastWeek, change: lastWeek > 0 ? Math.round(((total - lastWeek) / lastWeek) * 100) : null, spark: series.slice(-14).map((d) => d.total) };
    }
    if (seeOrders) {
      const o = await tx.query<{ open: number; open_value: number; ready: number; ready_units: number; quotes: number; quote_value: number }>(
        `select count(*) filter (where s.status in ('confirmed', 'partially_shipped'))::int as open,
                coalesce(sum(s.total) filter (where s.status in ('confirmed', 'partially_shipped')), 0)::float8 as open_value,
                count(*) filter (where s.status in ('confirmed', 'partially_shipped') and s.reserved > 0)::int as ready,
                coalesce(sum(s.reserved) filter (where s.status in ('confirmed', 'partially_shipped')), 0)::float8 as ready_units,
                count(*) filter (where s.status = 'quote')::int as quotes,
                coalesce(sum(s.total) filter (where s.status = 'quote'), 0)::float8 as quote_value
           from (select o.status,
                        (select coalesce(sum(l.qty * l.unit_price), 0) from sales_order_lines l where l.order_id = o.id) as total,
                        (select coalesce(sum(l.qty_reserved), 0) from sales_order_lines l where l.order_id = o.id) as reserved
                   from sales_orders o) s`,
      );
      const r = o.rows[0]!;
      if (stock) out.readyToShip = { orders: r.ready, units: r.ready_units, open: r.open };
      else {
        out.openOrders = { count: r.open, value: r.open_value };
        out.openQuotes = { count: r.quotes, value: r.quote_value };
      }
    }
    if (can(ctx, "invoice.write")) {
      const u = await tx.query<{ amount: number; count: number; overdue: number }>(
        `select coalesce(sum(b.balance), 0)::float8 as amount, count(*)::int as count,
                count(*) filter (where b.due_at < date_trunc('day', now()))::int as overdue
           from (select i.due_at, i.amount - coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id), 0)
                                           - coalesce((select sum(a.amount) from credit_applications a where a.invoice_id = i.id), 0) as balance
                   from invoices i where i.voided_at is null) b
          where b.balance > 0`,
      );
      out.unpaid = u.rows[0]!;
    } else if (featureOn(ctx.features, "purchasing") && can(ctx, "purchase_order.read")) {
      const d = await tx.query<{ n: number }>("select count(*)::int as n from purchase_orders where status in ('approved', 'sent', 'partially_received')");
      out.deliveries = d.rows[0]!.n;
    }
    if (stock && can(ctx, "product.read")) {
      const l = await tx.query<{ count: number; on_order: number }>(
        `select count(*)::int as count,
                count(*) filter (where exists (select 1 from purchase_order_lines pl join purchase_orders po on po.id = pl.order_id
                                                where pl.product_id = p.id and po.status in ('approved', 'sent', 'partially_received')
                                                  and pl.qty > pl.qty_received))::int as on_order
           from products p
          where p.status = 'active' and p.reorder_point is not null
            and coalesce((select sum(on_hand - reserved) from stock_levels s where s.product_id = p.id), 0) <= p.reorder_point`,
      );
      out.lowStock = { count: l.rows[0]!.count, onOrder: l.rows[0]!.on_order };
    }
    return out;
  });
}

export const CHART_PERIODS = ["30d", "quarter", "ytd"] as const;
export type ChartPeriod = (typeof CHART_PERIODS)[number];
export const isChartPeriod = (value: string): value is ChartPeriod => (CHART_PERIODS as readonly string[]).includes(value);

export type SalesSeries = {
  period: ChartPeriod;
  /** One point per day, or per week (labelled by the week's first day in the period) for year to date. */
  bucket: "day" | "week";
  points: { date: string; total: number }[];
  total: number;
  from: string;
  to: string;
};

/**
 * Sales for the chart: the last 30 days, this calendar quarter so far, or this year so far.
 * Same definition as everywhere else: orders confirmed, goods before tax, cancelled left out.
 */
export async function salesSeries(ctx: Ctx, period: ChartPeriod): Promise<SalesSeries | null> {
  if (!can(ctx, "sales_order.read")) return null;
  const start =
    period === "30d" ? "(now() at time zone $1)::date - 29"
    : period === "quarter" ? "date_trunc('quarter', now() at time zone $1)::date"
    : "date_trunc('year', now() at time zone $1)::date";
  const weekly = period === "ytd";
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<{ date: string; total: number; first: string; last: string }>(
      `with span as (select ${start} as first, (now() at time zone $1)::date as last),
            days as (select generate_series(first, last, interval '1 day')::date as day from span),
            daily as (select d.day,
                             coalesce((select sum(x.amount) from (${LINES}) x where (x.confirmed_at at time zone $1)::date = d.day), 0) as total
                        from days d)
       select to_char(min(day), 'YYYY-MM-DD') as date, sum(total)::float8 as total,
              to_char((select first from span), 'YYYY-MM-DD') as first, to_char((select last from span), 'YYYY-MM-DD') as last
         from daily
        group by ${weekly ? "date_trunc('week', day)" : "day"}
        order by 1`,
      [zoneOf(ctx)],
    );
    const points = result.rows.map(({ date, total }) => ({ date, total }));
    return {
      period,
      bucket: weekly ? "week" : "day",
      points,
      total: points.reduce((sum, p) => sum + p.total, 0),
      from: result.rows[0]!.first,
      to: result.rows[0]!.last,
    };
  });
}
