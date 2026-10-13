import Link from "next/link";
import { analysis, ANALYSIS_PRESETS, can, COMPARE_MODES, daysIn, featureOn, type Analysis, type Pair } from "@bos/core";
import { CompareChart } from "../../../components/home/charts";
import { ReportControls } from "../../../components/ReportControls";
import { formatQty } from "../../../lib/format";
import { COMPARE_LABEL, PRESET_LABEL, rangeText, readReportQuery, reportHref, type ReportQuery, type ReportTab, type ReportView } from "../../../lib/report-params";
import { requireSession } from "../../../lib/session";
import { whole } from "../../../lib/locale";

const count = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const ROWS = 100;

/** How a figure moved against the comparison dates. An arrow and a word carry it, never colour alone. */
function Delta({ pair, good = "up" }: { pair: Pair; good?: "up" | "down" | "neither" }) {
  if (pair.was === null) return null;
  const diff = pair.now - pair.was;
  if (Math.abs(diff) < 0.005) return <span className="delta delta-flat">No change</span>;
  const up = diff > 0;
  const tone = good === "neither" ? "flat" : (good === "up") === up ? "good" : "bad";
  const text = pair.was === 0 ? (up ? "New" : "From zero") : `${Math.abs(Math.round((diff / Math.abs(pair.was)) * 100))}%`;
  return (
    <span className={`delta delta-${tone}`}>
      <span aria-hidden="true">{up ? "▲" : "▼"}</span> <span className="sr-only">{up ? "Up" : "Down"}</span> {text}
    </span>
  );
}

function Tile({ label, pair, format, good, note }: { label: string; pair: Pair; format: (n: number) => string; good?: "up" | "down" | "neither"; note?: string }) {
  return (
    <div className="glass panel tile">
      <h2 className="label">{label}</h2>
      <div className="numeral">{format(pair.now)}</div>
      <div className="muted rpt-sub">
        {pair.was !== null && <Delta pair={pair} good={good} />}
        {pair.was !== null ? <span>was {format(pair.was)}</span> : note ? <span>{note}</span> : null}
      </div>
    </div>
  );
}

function Download({ view, table }: { view: ReportView; table: string }) {
  return (
    <a className="btn btn-glass btn-small" href={reportHref(view, {}, "/reports/export", { table })} download>
      Download spreadsheet
    </a>
  );
}

/** A table whose money columns come in pairs: these dates, the comparison dates and the change. */
function PairTable({ view, table, title, note, first, rows, columns }: {
  view: ReportView; table: string; title: string; note?: string; first: string;
  rows: { key: string; label: React.ReactNode; values: Pair[] }[];
  columns: { name: string; format: (n: number) => string; good?: "up" | "down" | "neither" }[];
}) {
  const compared = view.compare !== null;
  const shown = rows.slice(0, ROWS);
  return (
    <section className="glass panel">
      <div className="panel-head">
        <div>
          <h2 className="title">{title}</h2>
          {note && <p className="muted">{note}</p>}
        </div>
        {rows.length > 0 && <Download view={view} table={table} />}
      </div>
      {rows.length === 0 ? (
        <p className="muted rpt-none">Nothing in these dates.</p>
      ) : (
        <div className="table-wrap">
          <table className="compact rpt-table">
            <thead>
              <tr>
                <th scope="col">{first}</th>
                {columns.map((c) => (
                  <th scope="col" className="num" key={c.name} colSpan={compared ? 3 : 1}>{c.name}</th>
                ))}
              </tr>
              {compared && (
                <tr className="rpt-subhead">
                  <th />
                  {columns.map((c) => [
                    <th scope="col" className="num" key={`${c.name}-n`}>These dates</th>,
                    <th scope="col" className="num" key={`${c.name}-w`}>Compared</th>,
                    <th scope="col" className="num" key={`${c.name}-c`}>Change</th>,
                  ])}
                </tr>
              )}
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key}>
                  <th scope="row">{r.label}</th>
                  {r.values.map((p, i) => {
                    const c = columns[i]!;
                    return compared
                      ? [
                          <td className="num" key={`${i}-n`}>{c.format(p.now)}</td>,
                          <td className="num muted" key={`${i}-w`}>{c.format(p.was ?? 0)}</td>,
                          <td className="num" key={`${i}-c`}><Delta pair={p} good={c.good} /></td>,
                        ]
                      : <td className="num" key={i}>{c.format(p.now)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > ROWS && <p className="muted footnote">Showing the first {ROWS} of {rows.length}. The spreadsheet has them all.</p>}
    </section>
  );
}

function Bars({ items, tone = "accent" }: { items: { key: string; label: string; value: number; text: string; tone?: "accent" | "warn" | "bad" }[]; tone?: "accent" | "warn" | "bad" }) {
  const max = Math.max(...items.map((i) => i.value), 0);
  return (
    <div className="rep-bars">
      {items.map((i) => (
        <div className="rep-row" key={i.key}>
          <div className="rep-label">{i.label}</div>
          <div className="rep-track" aria-hidden="true">
            <div className={`rep-fill rep-${i.tone ?? tone}`} style={{ width: `${max > 0 ? Math.max((i.value / max) * 100, i.value > 0 ? 1.5 : 0) : 0}%` }} />
          </div>
          <div className="rep-value">{i.text}</div>
        </div>
      ))}
    </div>
  );
}

function Overview({ data, view }: { data: Analysis; view: ReportView }) {
  const s = data.sales;
  const tick = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", data.bucket === "month" ? { month: "short", year: "2-digit", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" });
  const step = data.bucket === "day" ? "day by day" : data.bucket === "week" ? "week by week" : "month by month";
  return (
    <>
      <div className="tiles">
        <Tile label="Sales" pair={s.revenue} format={whole} />
        <Tile label="Orders" pair={s.orders} format={count} />
        <Tile label="Average order" pair={s.average} format={whole} />
        <Tile label="Units sold" pair={s.units} format={formatQty} />
        {s.margin && <Tile label="Margin" pair={s.margin} format={whole} note="Sales less cost of goods" />}
        {(s.returns.now > 0 || (s.returns.was ?? 0) > 0) && <Tile label="Returns" pair={s.returns} format={whole} good="down" note="Goods sent back, before tax" />}
        {(s.returns.now > 0 || (s.returns.was ?? 0) > 0) && <Tile label="Sales after returns" pair={s.net} format={whole} />}
        <Tile label="Customers buying" pair={s.customers} format={count} />
        <Tile label="New customers" pair={s.newCustomers} format={count} />
      </div>
      <section className="glass panel">
        <div className="panel-head">
          <div>
            <h2 className="title">Sales, {step}</h2>
            <p className="muted rpt-legend">
              <span><i className="rpt-key" /> {rangeText(data.range)}</span>
              {data.compare && <span><i className="rpt-key rpt-key-was" /> {rangeText(data.compare)}</span>}
            </p>
          </div>
          <Download view={view} table="trend" />
        </div>
        {s.orders.now === 0 && (s.orders.was ?? 0) === 0 ? (
          <p className="muted rpt-none">No orders were confirmed in these dates. Try a longer period.</p>
        ) : (
          <CompareChart
            steps={data.trend}
            tick={tick}
            animate={`${data.range.from}${data.range.to}${data.mode}`}
            label={`Sales ${step}: ${whole(s.revenue.now)} in these dates${s.revenue.was !== null ? `, ${whole(s.revenue.was)} in the dates compared` : ""}`}
          />
        )}
      </section>
      <PairTable
        view={view} table="categories" title="Sales by category" first="Category"
        rows={data.categories.map((c) => ({ key: c.name, label: c.name, values: [c.revenue] }))}
        columns={[{ name: "Sales", format: whole }]}
      />
      <PairTable
        view={view} table="people" title="Sales by person" note="By who owns the order." first="Person"
        rows={data.people.map((p) => ({ key: p.id ?? "none", label: p.name, values: [p.orders, p.revenue] }))}
        columns={[{ name: "Orders", format: count }, { name: "Sales", format: whole }]}
      />
    </>
  );
}

function Money({ data, view }: { data: Analysis; view: ReportView }) {
  const m = data.money;
  const days = (n: number) => `${Math.round(n)} ${Math.round(n) === 1 ? "day" : "days"}`;
  return (
    <>
      <div className="tiles">
        <Tile label="Invoiced" pair={m.invoiced} format={whole} note="Tax included" />
        <Tile label="Payments received" pair={m.collected} format={whole} />
        <Tile label="Credit notes" pair={m.credits} format={whole} good="down" />
        <Tile label="Refunds paid" pair={m.refunded} format={whole} good="down" note="Money paid back to customers" />
        <div className="glass panel tile">
          <h2 className="label">Days to get paid</h2>
          <div className="numeral">{m.daysToPay.now === null ? "–" : days(m.daysToPay.now)}</div>
          <div className="muted rpt-sub">
            {m.daysToPay.now === null ? (
              <span>No payments in these dates</span>
            ) : m.daysToPay.was !== null ? (
              <>
                <Delta pair={{ now: Math.round(m.daysToPay.now), was: Math.round(m.daysToPay.was) }} good="down" />
                <span>was {days(m.daysToPay.was)}</span>
              </>
            ) : (
              <span>From invoice to payment</span>
            )}
          </div>
        </div>
        <Link href="/invoices?show=open" className="glass panel tile">
          <h2 className="label">Owed to you today</h2>
          <div className="numeral">{whole(m.owed.total)}</div>
          <div className="muted">{m.owed.total - m.owed.current > 0 ? `${whole(m.owed.total - m.owed.current)} overdue` : "Nothing overdue"}</div>
        </Link>
      </div>
      {m.owed.total > 0 && (
        <section className="glass panel">
          <h2 className="title">What customers owe today, by age</h2>
          <Bars
            items={[
              { key: "c", label: "Not due yet", value: m.owed.current, text: whole(m.owed.current) },
              { key: "1", label: "1 to 30 days late", value: m.owed.late30, text: whole(m.owed.late30), tone: "warn" },
              { key: "2", label: "31 to 60 days late", value: m.owed.late60, text: whole(m.owed.late60), tone: "warn" },
              { key: "3", label: "Over 60 days late", value: m.owed.older, text: whole(m.owed.older), tone: "bad" },
            ]}
          />
        </section>
      )}
      {m.debtors.length > 0 && (
        <section className="glass panel">
          <div className="panel-head">
            <h2 className="title">Who owes you today</h2>
            <Download view={view} table="owed" />
          </div>
          <div className="table-wrap">
            <table className="compact rpt-table">
              <thead>
                <tr><th scope="col">Customer</th><th scope="col" className="num">Owed</th><th scope="col" className="num">Overdue</th><th scope="col" className="num">Oldest</th></tr>
              </thead>
              <tbody>
                {m.debtors.map((d) => (
                  <tr key={d.id}>
                    <th scope="row"><Link href={`/customers/${d.id}`} className="row-link">{d.name}</Link></th>
                    <td className="num">{whole(d.owed)}</td>
                    <td className="num">{d.overdue > 0 ? whole(d.overdue) : "–"}</td>
                    <td className="num">{d.oldest > 0 ? `${d.oldest} ${d.oldest === 1 ? "day" : "days"} late` : "Not due"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function Profit({ data, costs, view }: { data: Analysis; costs: NonNullable<Analysis["costs"]>; view: ReportView }) {
  const margin = data.sales.margin;
  return (
    <>
      <div className="tiles">
        {costs.profit && <Tile label="Profit" pair={costs.profit} format={whole} note="Margin less running costs" />}
        <Tile label="Sales" pair={data.sales.revenue} format={whole} />
        {margin && <Tile label="Margin on goods sold" pair={margin} format={whole} note="Sales less cost of goods" />}
        <Tile label="Running costs" pair={costs.running} format={whole} good="down" note="Everything but stock purchases" />
        <Tile label="Stock purchases" pair={costs.stockPurchases} format={whole} good="neither" note="Not taken off profit again" />
        <Link href="/bills" className="glass panel tile">
          <h2 className="label">You owe today</h2>
          <div className="numeral">{whole(costs.owed)}</div>
          <div className="muted">{costs.overdue > 0 ? `${whole(costs.overdue)} overdue` : "Nothing overdue"}</div>
        </Link>
      </div>
      {costs.profit && margin && (
        <section className="glass panel">
          <h2 className="title">How profit is worked out</h2>
          <div className="table-wrap">
            <table className="compact rpt-table rpt-sum">
              <tbody>
                <tr><th scope="row">Sales, before tax</th><td className="num">{whole(data.sales.revenue.now)}</td></tr>
                <tr><th scope="row">Less cost of the goods sold, and margin given up on returns</th><td className="num">− {whole(data.sales.revenue.now - margin.now)}</td></tr>
                <tr><th scope="row">Margin</th><td className="num">{whole(margin.now)}</td></tr>
                <tr><th scope="row">Less running costs</th><td className="num">− {whole(costs.running.now)}</td></tr>
                <tr className="rpt-total"><th scope="row">Profit</th><td className="num">{whole(costs.profit.now)}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="muted footnote">Cost of goods is what each product cost on the day its order was confirmed. Costs count by the date of the bill or purchase, paid or not. A return takes its margin back off; goods not fit to restock take the whole sale off. This is a working figure, not a tax return.</p>
        </section>
      )}
      <PairTable
        view={view} table="costs" title="Costs by category" first="Category"
        rows={costs.categories.map((c) => ({ key: c.name, label: c.name, values: [c.amount] }))}
        columns={[{ name: "Amount", format: whole, good: "down" }]}
      />
    </>
  );
}

function Stock({ stock, view }: { stock: NonNullable<Analysis["stock"]>; view: ReportView }) {
  return (
    <>
      <div className="tiles">
        <Link href="/products" className="glass panel tile">
          <h2 className="label">Stock value today</h2>
          <div className="numeral">{whole(stock.value)}</div>
          <div className="muted">{formatQty(stock.units)} units at cost</div>
        </Link>
        <Link href="/products?low=1" className="glass panel tile">
          <h2 className="label">Running low</h2>
          <div className="numeral">{stock.lowStock}</div>
          <div className="muted">{stock.lowStock === 1 ? "product" : "products"} at or under the reorder point</div>
        </Link>
        <div className="glass panel tile">
          <h2 className="label">Tied up in stock that did not sell</h2>
          <div className="numeral">{whole(stock.idleValue)}</div>
          <div className="muted">{stock.value > 0 ? `${Math.round((stock.idleValue / stock.value) * 100)}% of stock value` : "No stock"}</div>
        </div>
      </div>
      <section className="glass panel">
        <div className="panel-head">
          <div>
            <h2 className="title">On the shelf, nothing sold in these dates</h2>
            <p className="muted">Most money tied up first.</p>
          </div>
          {stock.idle.length > 0 && <Download view={view} table="idle" />}
        </div>
        {stock.idle.length === 0 ? (
          <p className="muted rpt-none">Everything in stock sold at least once in these dates.</p>
        ) : (
          <div className="table-wrap">
            <table className="compact rpt-table">
              <thead>
                <tr><th scope="col">Product</th><th scope="col" className="num">On hand</th><th scope="col" className="num">Value at cost</th></tr>
              </thead>
              <tbody>
                {stock.idle.map((p) => (
                  <tr key={p.id}>
                    <th scope="row"><Link href={`/products/${p.id}`} className="row-link">{p.name}</Link> <span className="muted">{p.sku}</span></th>
                    <td className="num">{formatQty(p.onHand)}</td>
                    <td className="num">{whole(p.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Purchasing({ data, view }: { data: NonNullable<Analysis["purchasing"]>; view: ReportView }) {
  return (
    <>
      <div className="tiles">
        <Tile label="Ordered from suppliers" pair={data.ordered} format={whole} good="neither" note="Purchase orders approved" />
        <Tile label="Purchase orders" pair={data.count} format={count} good="neither" />
        <Tile label="Goods received" pair={data.received} format={whole} good="neither" note="At purchase order cost" />
        <Link href="/purchasing?show=open" className="glass panel tile">
          <h2 className="label">Still to arrive today</h2>
          <div className="numeral">{whole(data.open.value)}</div>
          <div className="muted">
            {data.open.count} open {data.open.count === 1 ? "order" : "orders"}{data.open.late > 0 ? ` · ${data.open.late} late` : ""}
          </div>
        </Link>
      </div>
      <PairTable
        view={view} table="suppliers" title="Ordered by supplier" first="Supplier"
        rows={data.suppliers.map((s) => ({ key: s.id, label: s.name, values: [s.orders, s.ordered] }))}
        columns={[{ name: "Orders", format: count, good: "neither" }, { name: "Ordered", format: whole, good: "neither" }]}
      />
    </>
  );
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<ReportQuery> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "report.view") || !featureOn(ctx.features, "reports")) {
    return (
      <section className="glass panel empty">
        <div className="empty-title">Reports are not available</div>
        <p>Either reports are switched off for this company or your role does not include them.</p>
      </section>
    );
  }
  const asked = readReportQuery(await searchParams);
  const data = await analysis(ctx, { range: asked.range, mode: asked.mode });
  const tabs: { key: ReportTab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "products", label: "Products" },
    ...(can(ctx, "customer.read") ? [{ key: "customers" as const, label: "Customers" }] : []),
    { key: "money", label: "Money" },
    ...(data.costs ? [{ key: "profit" as const, label: "Profit and costs" }] : []),
    ...(data.stock ? [{ key: "stock" as const, label: "Stock" }] : []),
    ...(data.purchasing ? [{ key: "purchasing" as const, label: "Purchasing" }] : []),
  ];
  const view: ReportView = { ...asked, tab: tabs.some((t) => t.key === asked.tab) ? asked.tab : "overview" };
  const showMargin = data.products.some((p) => p.margin !== null);
  const n = daysIn(data.range);

  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            {rangeText(data.range)} · {n} {n === 1 ? "day" : "days"}
            {data.compare ? ` · compared with ${rangeText(data.compare)}` : ""}
          </div>
          <h1>Reports</h1>
        </div>
        <ReportControls
          key={`${view.preset}${view.range.from}${view.range.to}`}
          period={view.preset} compare={view.mode} from={view.range.from} to={view.range.to} tab={view.tab}
          periods={ANALYSIS_PRESETS.map((p) => ({ value: p, label: PRESET_LABEL[p] }))}
          compares={COMPARE_MODES.map((m) => ({ value: m, label: COMPARE_LABEL[m] }))}
        />
      </header>
      <nav className="segmented rpt-tabs" aria-label="Report sections">
        {tabs.map((t) => (
          <Link key={t.key} href={reportHref(view, { tab: t.key })} aria-current={t.key === view.tab ? "page" : undefined} scroll={false}>
            {t.label}
          </Link>
        ))}
      </nav>

      {view.tab === "overview" && <Overview data={data} view={view} />}
      {view.tab === "products" && (
        <PairTable
          view={view} table="products" title="Every product sold" first="Product"
          note={`Sales are orders confirmed, before tax.${showMargin ? " Margin is sales less what each product cost on the day its order was confirmed." : ""}`}
          rows={data.products.map((p) => ({
            key: p.id,
            label: <><Link href={`/products/${p.id}`} className="row-link">{p.name}</Link> <span className="muted">{p.sku}</span></>,
            values: [p.units, p.revenue, ...(showMargin && p.margin ? [p.margin] : [])],
          }))}
          columns={[{ name: "Units", format: formatQty }, { name: "Sales", format: whole }, ...(showMargin ? [{ name: "Margin", format: whole }] : [])]}
        />
      )}
      {view.tab === "customers" && (
        <PairTable
          view={view} table="customers" title="Every customer who bought" first="Customer"
          note="New means their first ever order is in these dates."
          rows={data.customers.map((c) => ({
            key: c.id,
            label: <><Link href={`/customers/${c.id}`} className="row-link">{c.name}</Link>{c.isNew && <> <span className="badge badge-info">New</span></>}</>,
            values: [c.orders, c.revenue],
          }))}
          columns={[{ name: "Orders", format: count }, { name: "Sales", format: whole }]}
        />
      )}
      {view.tab === "money" && <Money data={data} view={view} />}
      {view.tab === "profit" && data.costs && <Profit data={data} costs={data.costs} view={view} />}
      {view.tab === "stock" && data.stock && <Stock stock={data.stock} view={view} />}
      {view.tab === "purchasing" && data.purchasing && <Purchasing data={data.purchasing} view={view} />}
    </>
  );
}
