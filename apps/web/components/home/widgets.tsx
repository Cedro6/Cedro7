import Link from "next/link";
import type { ReactNode } from "react";
import {
  attention, calendarEntries, can, featureOn, headline, heroFigures, listInvoices, listOrders, listProducts, orderHeatmap,
  putawayList, report, salesSeries, type ChartPeriod, type Ctx, type HeroRange, type WidgetId,
} from "@bos/core";
import { formatMoney, formatQty } from "../../lib/format";
import { AreaChart, BarList, Sparkline } from "./charts";
import { todayHere, whole } from "../../lib/locale";

const shortDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const todayIso = () => todayHere();
const ago = (date: Date) => {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
};

/** What the person has chosen on Home, carried in the address so a choice on one card keeps the others. */
export type HomeView = { range: HeroRange; chart: ChartPeriod; edit: boolean };
const homeHref = (view: HomeView, change: Partial<HomeView>) => {
  const next = { ...view, ...change };
  const parts = [next.range !== 30 ? `range=${next.range}` : "", next.chart !== "30d" ? `chart=${next.chart}` : "", next.edit ? "edit=1" : ""].filter(Boolean);
  return parts.length ? `/?${parts.join("&")}` : "/";
};

/** What each card is called, what it shows, and how wide it sits. */
export const WIDGET_INFO: Record<WidgetId, { name: string; about: string; size: "full" | "wide" | "narrow" }> = {
  hero: { name: "Total sales", about: "The big sales figure with the change, what is still to collect, and the split by category", size: "full" },
  tiles: { name: "Headline numbers", about: "Sales this week, ready to ship, unpaid invoices and low stock at a glance", size: "full" },
  sales: { name: "Sales chart", about: "Daily sales for the last 30 days", size: "wide" },
  invoices: { name: "Recent invoices", about: "The latest invoices with paid, unpaid or overdue tags", size: "narrow" },
  attention: { name: "Needs attention", about: "Overdue invoices, low stock, orders ready to ship, late deliveries and quiet customers", size: "narrow" },
  today: { name: "Today", about: "Today's reminders, expected deliveries and invoices falling due", size: "narrow" },
  "top-products": { name: "Top products", about: "Best sellers over the last 30 days", size: "wide" },
  "top-customers": { name: "Top customers", about: "Who bought the most over the last 30 days", size: "wide" },
  calendar: { name: "Calendar", about: "This month at a glance, with dots on days that have something on", size: "narrow" },
  heatmap: { name: "Orders by time", about: "When orders are placed, by weekday and hour", size: "narrow" },
  ship: { name: "To pick and ship", about: "Open orders with stock reserved, oldest first", size: "wide" },
  "low-stock": { name: "Low stock", about: "Products at or under their reorder point", size: "narrow" },
  putaway: { name: "To put away", about: "Deliveries received but not yet on the shelf", size: "narrow" },
  quotes: { name: "Open quotes", about: "Quotes waiting on the customer, oldest first", size: "narrow" },
  "lot-tiles": { name: "Headline numbers", about: "Cars on the lot, cars over 60 days, money in stock and reminders due", size: "full" },
  "dealer-sales": { name: "Sales chart", about: "Money from cars delivered, from 7 days to 12 months", size: "full" },
  "dealer-deals": { name: "Deals chart", about: "How many deals were written, and how many are still open, from 7 days to 12 months", size: "full" },
  "lot-attention": { name: "Needs attention", about: "Money owed, deals ready to deliver, title paperwork gaps and cars sitting too long", size: "narrow" },
  "open-deals": { name: "Open deals", about: "Deals not yet delivered, with what each buyer still owes", size: "wide" },
  "newest-cars": { name: "Newest on the lot", about: "The latest cars in, with mileage, asking price and status", size: "wide" },
  "aged-cars": { name: "Been here longest", about: "Cars on hand 60 days or more, oldest first", size: "narrow" },
};

function Panel({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="glass panel">
      <div className="panel-head">
        <h2 className="title">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}
const Empty = ({ children }: { children: ReactNode }) => <p className="muted">{children}</p>;

async function Hero({ ctx, view }: { ctx: Ctx; view: HomeView }) {
  const hero = await heroFigures(ctx, view.range);
  if (!hero) return null;
  const [dollars, cents] = formatMoney(hero.total).split(".");
  return (
    <section className="hero">
      <div className="hero-main">
        <div className="hero-label">Total sales</div>
        <div className="hero-figure">
          <span className="hero-number">
            {dollars}
            <span className="dim">.{cents ?? "00"}</span>
          </span>
          {hero.change !== null && (
            <span className={`hero-change ${hero.change < 0 ? "is-down" : ""}`}>
              {hero.change >= 0 ? "+" : "−"}
              {Math.abs(hero.change).toFixed(1)}%
            </span>
          )}
        </div>
        <div className="hero-sub">
          {hero.toCollect !== null ? (
            <>
              Still to collect: <strong>{formatMoney(hero.toCollect)}</strong>
            </>
          ) : (
            `${shortDay(hero.from)} to ${shortDay(hero.to)}`
          )}
        </div>
        <div className="actions">
          {can(ctx, "sales_order.write") && (
            <Link href="/sales/new" className="btn btn-primary btn-small">
              New order
            </Link>
          )}
          {can(ctx, "invoice.write") && (
            <Link href="/invoices/new" className="btn btn-primary btn-small">
              New invoice
            </Link>
          )}
          {featureOn(ctx.features, "reports") && (
            <Link href="/reports" className="btn btn-glass btn-small">
              Reports
            </Link>
          )}
        </div>
      </div>
      <div className="hero-side">
        <div className="hero-range">
          <div className="segmented" role="group" aria-label="Period">
            {([[7, "Week"], [30, "Month"], [60, "60 days"]] as const).map(([days, label]) => (
              <Link key={days} href={homeHref(view, { range: days })} aria-current={days === hero.days ? "true" : undefined} scroll={false}>
                {label}
              </Link>
            ))}
          </div>
        </div>
        <div className="hero-bars">
          {hero.categories.length === 0 ? (
            <Empty>No sales in this period yet.</Empty>
          ) : (
            hero.categories.map((c, i) => (
              <div className="hero-block" key={c.name} style={{ flexGrow: Math.max(0.6, c.share * 4) }}>
                <div className="hero-amount">{formatMoney(c.amount)}</div>
                <div className="hero-rule" />
                <div className="hero-cat">
                  <strong>{Math.round(c.share * 100)}%</strong> {c.name}
                </div>
                <div className={`stripes stripes-${i}`} role="img" aria-label={`${c.name}: ${Math.round(c.share * 100)} percent of sales`} />
              </div>
            ))
          )}
        </div>
        <div className="hero-dates">
          <span>{shortDay(hero.from)}</span>
          <span>Orders confirmed, before tax</span>
          <span>{shortDay(hero.to)}</span>
        </div>
      </div>
    </section>
  );
}

function Tile({ label, value, sub, href, children }: { label: string; value: ReactNode; sub: string; href: string; children?: ReactNode }) {
  return (
    <Link href={href} className="glass panel tile">
      <h2 className="label">{label}</h2>
      <div className="numeral">{value}</div>
      <div className="muted">{sub}</div>
      {children}
    </Link>
  );
}

async function Tiles({ ctx }: { ctx: Ctx }) {
  const h = await headline(ctx);
  const s = h.salesThisWeek;
  return (
    <div className="tiles">
      {s && (
        <Tile label="Sales, last 7 days" value={whole(s.total)} sub={s.change === null ? "No sales in the 7 days before" : `${whole(s.lastWeek)} in the 7 days before`} href={featureOn(ctx.features, "reports") ? "/reports" : "/sales"}>
          <div className="tile-foot">
            {s.change !== null ? <span className={`badge ${s.change >= 0 ? "badge-ok" : "badge-bad"}`}>{s.change >= 0 ? "+" : ""}{s.change}%</span> : <span />}
            <Sparkline values={s.spark} />
          </div>
        </Tile>
      )}
      {h.openOrders && <Tile label="Open orders" value={h.openOrders.count} sub={h.openOrders.count ? `${whole(h.openOrders.value)} to complete and invoice` : "Nothing in progress"} href="/sales?show=open" />}
      {h.openQuotes && <Tile label="Open quotes" value={h.openQuotes.count} sub={h.openQuotes.count ? `${whole(h.openQuotes.value)} waiting on customers` : "Nothing waiting on a customer"} href="/sales?show=quote" />}
      {h.readyToShip && <Tile label="Ready to ship" value={h.readyToShip.orders} sub={`${formatQty(h.readyToShip.units)} units across ${h.readyToShip.open} open ${h.readyToShip.open === 1 ? "order" : "orders"}`} href="/sales?show=open" />}
      {h.unpaid && <Tile label="Unpaid invoices" value={whole(h.unpaid.amount)} sub={h.unpaid.overdue ? `${h.unpaid.overdue} overdue` : `${h.unpaid.count} open, none overdue`} href="/invoices?show=open" />}
      {h.deliveries !== null && <Tile label="Deliveries expected" value={h.deliveries} sub="Purchase orders on the way" href="/purchasing?show=open" />}
      {h.lowStock && <Tile label="Low stock" value={h.lowStock.count} sub={`${h.lowStock.onOrder} already on order`} href="/products?low=1" />}
    </div>
  );
}

const CHART_LABEL: Record<ChartPeriod, { tab: string; title: string; empty: string }> = {
  "30d": { tab: "30 days", title: "Sales, last 30 days", empty: "No orders confirmed in the last 30 days." },
  quarter: { tab: "Quarter", title: "Sales, this quarter", empty: "No orders confirmed this quarter yet." },
  ytd: { tab: "Year to date", title: "Sales, year to date", empty: "No orders confirmed this year yet." },
};
async function SalesChart({ ctx, view }: { ctx: Ctx; view: HomeView }) {
  const data = await salesSeries(ctx, view.chart);
  if (!data) return null;
  const text = CHART_LABEL[data.period];
  const last = data.points.at(-1)?.total ?? 0;
  return (
    <section className="glass panel">
      <div className="panel-head">
        <div>
          <h2 className="title">{text.title}</h2>
          <div className="muted">
            {shortDay(data.from)} to {shortDay(data.to)} · orders confirmed, before tax{data.bucket === "week" ? " · by week" : ""}
          </div>
        </div>
        <div className="segmented" role="group" aria-label="Chart period">
          {(["30d", "quarter", "ytd"] as const).map((period) => (
            <Link key={period} href={homeHref(view, { chart: period })} aria-current={period === data.period ? "true" : undefined} scroll={false}>
              {CHART_LABEL[period].tab}
            </Link>
          ))}
        </div>
      </div>
      <div className="chart-total">
        <span className="numeral numeral-md">{whole(data.total)}</span>
        <span className="muted">
          total · {whole(last)} {data.bucket === "week" ? "this week" : "today"}
        </span>
      </div>
      {data.total > 0 && data.points.length > 1 ? (
        <AreaChart animate={data.period} series={data.points} label={`${text.title}: ${whole(data.total)} in total, shown ${data.bucket === "week" ? "week by week" : "day by day"}`} />
      ) : (
        <Empty>{data.total > 0 ? `${whole(data.total)} so far. The chart appears from the second day.` : text.empty}</Empty>
      )}
    </section>
  );
}

const TAG: Record<string, [string, string]> = { paid: ["paid", "Paid"], overdue: ["overdue", "Overdue"], part_paid: ["part", "Part paid"], void: ["void", "Void"], unpaid: ["unpaid", "Unpaid"] };
async function RecentInvoices({ ctx }: { ctx: Ctx }) {
  const list = [...(await listInvoices(ctx))].sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime()).slice(0, 6);
  return (
    <Panel title="Recent invoices" right={<Link href="/invoices" className="panel-link">All invoices</Link>}>
      {list.length === 0 ? (
        <Empty>No invoices yet.</Empty>
      ) : (
        <div className="rows tx">
          {list.map((i) => {
            const [cls, label] = TAG[i.state] ?? ["unpaid", i.state];
            return (
              <Link href={`/invoices/${i.id}`} className="row tx-row" key={i.id}>
                <span className="tx-name">{i.customerName}</span>
                <span className={`dot-tag dot-tag-${cls}`}>{label}</span>
                <span className="tx-amount">{formatMoney(i.amount)}</span>
              </Link>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

async function Attention({ ctx }: { ctx: Ctx }) {
  const list = await attention(ctx);
  return (
    <Panel title="Needs attention" right={<span className="muted">{list.length} {list.length === 1 ? "item" : "items"}</span>}>
      {list.length === 0 ? (
        <Empty>Nothing needs you right now.</Empty>
      ) : (
        <div className="rows scroll-rows">
          {list.map((item) => (
            <div className="row" key={item.kind}>
              <span className={`dot dot-${item.tone}`} aria-hidden="true" />
              <div className="row-text">
                <div className="row-title">{item.title}</div>
                <div className="muted">{item.detail}</div>
              </div>
              <Link href={item.href} className="btn btn-glass btn-small">
                {item.action}
              </Link>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

const KIND = { reminder: ["info", "Reminder"], delivery: ["ok", "Delivery expected"], invoice_due: ["warn", "Invoice due"] } as const;
async function Today({ ctx }: { ctx: Ctx }) {
  const day = todayIso();
  const list = await calendarEntries(ctx, day, day);
  return (
    <Panel title="Today" right={<Link href="/calendar" className="panel-link">Open calendar</Link>}>
      {list.length === 0 ? (
        <Empty>Nothing scheduled today.</Empty>
      ) : (
        <div className="rows">
          {list.map((e, i) => (
            <div className="row" key={i}>
              <span className={`dot dot-${KIND[e.kind][0]}`} aria-hidden="true" />
              <div className="row-text">
                <Link href={e.href} className={`row-link ${e.done ? "struck" : ""}`}>
                  {e.title}
                </Link>
                <div className="muted">{KIND[e.kind][1]}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

async function TopProducts({ ctx }: { ctx: Ctx }) {
  const data = featureOn(ctx.features, "reports") ? await report(ctx, 30) : null;
  const items = (data?.topProducts ?? []).slice(0, 6);
  return (
    <Panel title="Top products, last 30 days" right={data && <Link href="/reports" className="panel-link">All reports</Link>}>
      {!data ? <Empty>Switch Reports on in Settings to see this.</Empty> : items.length === 0 ? <Empty>No sales in this period.</Empty> : (
        <BarList items={items.map((p) => ({ key: p.id, label: <Link href={`/products/${p.id}`} className="row-link">{p.name}</Link>, sub: `${formatQty(p.units)} units`, value: p.revenue, text: whole(p.revenue) }))} />
      )}
    </Panel>
  );
}

async function TopCustomers({ ctx }: { ctx: Ctx }) {
  const data = featureOn(ctx.features, "reports") ? await report(ctx, 30) : null;
  const items = (data?.topCustomers ?? []).slice(0, 6);
  return (
    <Panel title="Top customers, last 30 days" right={<Link href="/customers" className="panel-link">All customers</Link>}>
      {!data ? <Empty>Switch Reports on in Settings to see this.</Empty> : items.length === 0 ? <Empty>No sales in this period.</Empty> : (
        <BarList items={items.map((c) => ({ key: c.id, label: <Link href={`/customers/${c.id}`} className="row-link">{c.name}</Link>, sub: `${c.orders} ${c.orders === 1 ? "order" : "orders"}`, value: c.revenue, text: whole(c.revenue) }))} />
      )}
    </Panel>
  );
}

async function MiniCalendar({ ctx }: { ctx: Ctx }) {
  const today = todayIso();
  const first = `${today.slice(0, 7)}-01`;
  const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
  const add = (iso: string, n: number) => new Date(at(iso).getTime() + n * 86_400_000).toISOString().slice(0, 10);
  const start = add(first, -((at(first).getUTCDay() + 6) % 7));
  const all = Array.from({ length: 42 }, (_, i) => add(start, i));
  const days = all.slice(0, all[35]!.slice(0, 7) === today.slice(0, 7) ? 42 : 35);
  const entries = await calendarEntries(ctx, days[0]!, days.at(-1)!);
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.date, (counts.get(e.date) ?? 0) + 1);
  return (
    <Panel title={at(first).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })} right={<Link href="/calendar" className="panel-link">Open calendar</Link>}>
      <div className="mini-cal">
        <div className="mini-grid mini-head" aria-hidden="true">
          {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>
        <div className="mini-grid">
          {days.map((iso) => {
            const n = counts.get(iso) ?? 0;
            const label = at(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
            return (
              <Link key={iso} href={`/calendar?month=${iso.slice(0, 7)}&day=${iso}`} className={`mini-day ${iso.slice(0, 7) === today.slice(0, 7) ? "" : "is-outside"} ${iso === today ? "is-today" : ""}`} aria-label={`${label}, ${n} ${n === 1 ? "entry" : "entries"}`}>
                <span>{Number(iso.slice(8))}</span>
                {n > 0 && <i />}
              </Link>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

async function HeatmapCard({ ctx }: { ctx: Ctx }) {
  const map = await orderHeatmap(ctx);
  if (!map) return null;
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hour = (h: number) => `${((h + 11) % 12) + 1} ${h < 12 ? "am" : "pm"}`;
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, 1 + Math.floor((n / Math.max(1, map.busiest)) * 3.999)));
  return (
    <Panel title="Orders by time" right={<span className="muted">Last 60 days</span>}>
      <div className="heat" role="img" aria-label={`Orders placed by weekday and hour over the last 60 days. The busiest slot has ${map.busiest} ${map.busiest === 1 ? "order" : "orders"}.`}>
        <span />
        {names.map((n) => (
          <span className="heat-head" key={n}>{n}</span>
        ))}
        {map.grid.map((row, r) => [
          <span className="heat-hour" key={`h${r}`}>{hour(map.hours[r]!)}</span>,
          ...row.map((n, c) => <i key={`${r}-${c}`} className={`heat-cell heat-${level(n)}`} title={`${names[c]} ${hour(map.hours[r]!)}: ${n} ${n === 1 ? "order" : "orders"}`} />),
        ])}
      </div>
      <div className="heat-legend">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <i key={l} className={`heat-cell heat-${l}`} />
        ))}
        <span>More</span>
      </div>
    </Panel>
  );
}

async function ShipQueue({ ctx }: { ctx: Ctx }) {
  const list = (await listOrders(ctx, { status: "open" })).filter((o) => o.unitsReserved > 0).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const pick = featureOn(ctx.features, "picking") && can(ctx, "sales_order.ship");
  return (
    <Panel title="To pick and ship" right={<Link href="/sales?show=open" className="panel-link">All open orders</Link>}>
      {list.length === 0 ? (
        <Empty>Nothing is waiting to ship.</Empty>
      ) : (
        <div className="rows">
          {list.slice(0, 8).map((o) => (
            <div className="row" key={o.id}>
              <div className="row-text">
                <Link href={`/sales/${o.id}`} className="row-link mono">{o.number}</Link>
                <div className="muted">{o.customerName} · {formatQty(o.unitsReserved)} units · ordered {ago(o.createdAt)}</div>
              </div>
              {pick ? (
                <Link href={`/warehouse?tab=pick&order=${o.id}`} className="btn btn-primary btn-small">Pick</Link>
              ) : (
                <Link href={`/sales/${o.id}`} className="btn btn-glass btn-small">Open</Link>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

async function LowStock({ ctx }: { ctx: Ctx }) {
  const list = await listProducts(ctx, { lowStockOnly: true });
  return (
    <Panel title="Low stock" right={<Link href="/products?low=1" className="panel-link">View all</Link>}>
      {list.length === 0 ? (
        <Empty>Nothing is running low.</Empty>
      ) : (
        <div className="rows scroll-rows">
          {list.map((p) => (
            <div className="row" key={p.id}>
              <div className="row-text">
                <Link href={`/products/${p.id}`} className="row-link">{p.name}</Link>
                <div className="muted">{formatQty(p.available)} available · reorder at {formatQty(p.reorderPoint ?? 0)}</div>
              </div>
              {p.onOrder > 0 ? <span className="badge badge-ok">{formatQty(p.onOrder)} on order</span> : <span className="badge badge-warn">Not on order</span>}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

async function Putaway({ ctx }: { ctx: Ctx }) {
  const lines = await putawayList(ctx);
  const byReceipt = new Map<string, { supplier: string; units: number }>();
  for (const line of lines) {
    const entry = byReceipt.get(line.receipt) ?? { supplier: line.supplier, units: 0 };
    entry.units += line.qty;
    byReceipt.set(line.receipt, entry);
  }
  return (
    <Panel title="To put away" right={<Link href="/warehouse?tab=putaway" className="panel-link">Warehouse</Link>}>
      {byReceipt.size === 0 ? (
        <Empty>The dock is clear.</Empty>
      ) : (
        <div className="rows">
          {[...byReceipt].map(([number, r]) => (
            <div className="row" key={number}>
              <div className="row-text">
                <div className="row-title mono">{number}</div>
                <div className="muted">{r.supplier} · {formatQty(r.units)} units</div>
              </div>
              <Link href="/warehouse?tab=putaway" className="btn btn-primary btn-small">Put away</Link>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

async function Quotes({ ctx }: { ctx: Ctx }) {
  const list = (await listOrders(ctx, { status: "quote" })).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return (
    <Panel title="Open quotes" right={<Link href="/sales?show=quote" className="panel-link">All quotes</Link>}>
      {list.length === 0 ? (
        <Empty>No quotes are waiting.</Empty>
      ) : (
        <div className="rows">
          {list.slice(0, 8).map((o) => (
            <div className="row" key={o.id}>
              <div className="row-text">
                <Link href={`/sales/${o.id}`} className="row-link mono">{o.number}</Link>
                <div className="muted">{o.customerName} · quoted {ago(o.createdAt)}</div>
              </div>
              <div className="strong">{formatMoney(o.total)}</div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Draws one Home card. */
export function Widget({ id, ctx, view }: { id: WidgetId; ctx: Ctx; view: HomeView }) {
  switch (id) {
    case "hero": return <Hero ctx={ctx} view={view} />;
    case "tiles": return <Tiles ctx={ctx} />;
    case "sales": return <SalesChart ctx={ctx} view={view} />;
    case "invoices": return <RecentInvoices ctx={ctx} />;
    case "attention": return <Attention ctx={ctx} />;
    case "today": return <Today ctx={ctx} />;
    case "top-products": return <TopProducts ctx={ctx} />;
    case "top-customers": return <TopCustomers ctx={ctx} />;
    case "calendar": return <MiniCalendar ctx={ctx} />;
    case "heatmap": return <HeatmapCard ctx={ctx} />;
    case "ship": return <ShipQueue ctx={ctx} />;
    case "low-stock": return <LowStock ctx={ctx} />;
    case "putaway": return <Putaway ctx={ctx} />;
    case "quotes": return <Quotes ctx={ctx} />;
  }
}
