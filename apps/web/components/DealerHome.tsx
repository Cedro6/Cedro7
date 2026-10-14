import Link from "next/link";
import { dealerAttention, dealSeries, DEALER_PERIODS, listDeals, listReminders, listVehicles, lotSummary, VEHICLE_STATUS_TEXT, type Ctx, type DealerPeriod, type DealSeries, type WidgetId } from "@bos/core";
import { AreaChart } from "./home/charts";
import { todayHere, whole } from "../lib/locale";

const PERIOD: Record<DealerPeriod, { tab: string; words: string }> = {
  "7d": { tab: "7D", words: "last 7 days" },
  "30d": { tab: "30D", words: "last 30 days" },
  quarter: { tab: "QTR", words: "this quarter" },
  ytd: { tab: "YTD", words: "year to date" },
  "12m": { tab: "12M", words: "last 12 months" },
};
const shortDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const shortMonth = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
/** The dates a chart covers, with the year when it starts in an earlier one. */
const span = (d: DealSeries) => (d.from.slice(0, 4) === d.to.slice(0, 4) ? `${shortDay(d.from)} to ${shortDay(d.to)}` : `${shortDay(d.from)}, ${d.from.slice(0, 4)} to ${shortDay(d.to)}, ${d.to.slice(0, 4)}`);
const BUCKET = { day: ["by day", "today"], week: ["by week", "this week"], month: ["by month", "this month"] } as const;

/** Each chart keeps its own period in the address, with the other chart's choice and Customize mode. */
export type DealerView = { sales: DealerPeriod; deals: DealerPeriod; edit: boolean };
type Choice = DealerView;
const homeHref = (choice: Choice, change: Partial<Pick<Choice, "sales" | "deals">>) => {
  const next = { ...choice, ...change };
  const parts = [next.sales !== "30d" ? `chart=${next.sales}` : "", next.deals !== "30d" ? `deals=${next.deals}` : "", next.edit ? "edit=1" : ""].filter(Boolean);
  return parts.length ? `/?${parts.join("&")}` : "/";
};

function Periods({ choice, which, label }: { choice: Choice; which: "sales" | "deals"; label: string }) {
  return (
    <div className="segmented segmented-compact" role="group" aria-label={label}>
      {DEALER_PERIODS.map((p) => (
        <Link key={p} href={homeHref(choice, { [which]: p })} aria-current={p === choice[which] ? "true" : undefined} aria-label={PERIOD[p].words} title={PERIOD[p].words} scroll={false}>{PERIOD[p].tab}</Link>
      ))}
    </div>
  );
}

/** The same sales chart as Clivada's Home: the money from cars delivered, drawn even when nothing has sold yet. */
async function DealerSalesChart({ ctx, choice }: { ctx: Ctx; choice: Choice }) {
  const data = await dealSeries(ctx, choice.sales);
  if (!data) return null;
  const last = data.points.at(-1)?.total ?? 0;
  const [by, now] = BUCKET[data.bucket];
  const tick = data.bucket === "month" ? shortMonth : shortDay;
  return (
    <section className="glass panel">
      <div className="panel-head">
        <div>
          <h2 className="title">Sales, {PERIOD[data.period].words}</h2>
          <div className="muted">{span(data)} · {by}</div>
        </div>
        <Periods choice={choice} which="sales" label="Sales chart period" />
      </div>
      <div className="chart-total">
        <span className="numeral numeral-md">{whole(data.total)}</span>
        <span className="muted">total · {data.cars} {data.cars === 1 ? "car" : "cars"} delivered · {whole(last)} {now}</span>
      </div>
      <AreaChart compact animate={`s${data.period}`} series={data.points} tick={tick} label={`Sales, ${PERIOD[data.period].words}: ${whole(data.total)} from ${data.cars} cars delivered, shown ${by}`} />
      <p className="muted chart-note">{data.total === 0 ? "No cars delivered in this period yet. " : ""}Sale price before tax and fees, counted the day the deal is delivered.</p>
    </section>
  );
}

/**
 * Deals in Clivada's Total sales style: the count, then one purple block per outcome, each as wide as its
 * share, with its number and percentage. Delivered is solid, still open striped, cancelled faint stripes.
 */
async function DealCountChart({ ctx, choice }: { ctx: Ctx; choice: Choice }) {
  const data = await dealSeries(ctx, choice.deals);
  if (!data) return null;
  const delivered = data.deals - data.open;
  const all = data.deals + data.cancelled;
  const parts = [
    { name: "Delivered", count: delivered },
    { name: "Still open", count: data.open },
    { name: "Cancelled", count: data.cancelled },
  ].map((p, i) => ({ ...p, stripe: i, share: all ? p.count / all : 0 })).filter((p) => p.count > 0);
  return (
    <section className="glass panel deals-card">
      <div className="panel-head">
        <div>
          <h2 className="title">Deals, {PERIOD[data.period].words}</h2>
          <div className="muted">{span(data)}</div>
        </div>
        <Periods choice={choice} which="deals" label="Deals chart period" />
      </div>
      <div className="chart-total">
        <span className="numeral numeral-md">{all}</span>
        <span className="muted">{all === 1 ? "deal" : "deals"} written · {delivered} delivered</span>
      </div>
      <div className="hero-bars deals-bars">
        {parts.length === 0 ? (
          <p className="muted">No deals written in this period yet.</p>
        ) : (
          parts.map((p) => (
            <div className="hero-block" key={p.name} style={{ flexGrow: Math.max(1.1, p.share * 4) }}>
              <div className="hero-amount">{p.count} {p.count === 1 ? "deal" : "deals"}</div>
              <div className="hero-rule" />
              <div className="hero-cat"><strong>{Math.round(p.share * 100)}%</strong> {p.name}</div>
              <div className={`stripes stripes-${p.stripe}`} role="img" aria-label={`${p.name}: ${p.count} of ${all} deals, ${Math.round(p.share * 100)} percent`} />
            </div>
          ))
        )}
      </div>
      <p className="muted chart-note">Counted the day each deal was written.</p>
    </section>
  );
}

const carName = (v: { year?: number | null; make?: string | null; model?: string | null; trim?: string | null; stockNumber: string }) =>
  [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ") || v.stockNumber;

/** The lot at a glance: what is on it, what is getting old, money tied up, and reminders due. */
async function LotTiles({ ctx }: { ctx: Ctx }) {
  const [lot, due] = await Promise.all([lotSummary(ctx), listReminders(ctx, { to: todayHere(), openOnly: true })]);
  return (
    <div className="tiles">
      <Link href="/vehicles?show=on_lot" className="glass panel tile"><h2 className="label">On the lot</h2><div className="numeral">{lot.onLot}</div><div className="muted">{lot.recon} in reconditioning · {lot.draft} drafts</div></Link>
      <Link href="/vehicles" className="glass panel tile"><h2 className="label">Over 60 days</h2><div className="numeral">{lot.aged}</div><div className="muted">{lot.aged === 0 ? "Nothing is getting old" : "Worth a price review"}</div></Link>
      {lot.invested !== null && <div className="glass panel tile"><h2 className="label">Invested in stock</h2><div className="numeral">{whole(lot.invested)}</div><div className="muted">What you paid for the {lot.live} on hand</div></div>}
      <Link href="/calendar" className="glass panel tile"><h2 className="label">Due today</h2><div className="numeral">{due.length}</div><div className="muted">{due.length === 0 ? "No reminders due" : `${due.filter((r) => r.overdue).length} overdue`}</div></Link>
    </div>
  );
}

async function NewestCars({ ctx }: { ctx: Ctx }) {
  const newest = (await listVehicles(ctx, { status: "live" })).slice(0, 6);
  return (
    <section className="glass panel">
      <div className="panel-head">
        <h2 className="title">Newest on the lot</h2>
        <Link href="/vehicles" className="panel-link">All vehicles</Link>
      </div>
      {newest.length === 0 ? (
        <p className="muted">No vehicles yet. Add the first one by its VIN.</p>
      ) : (
        <div className="table-wrap">
          <table className="compact">
            <thead><tr><th>Stock #</th><th>Vehicle</th><th className="num">Mileage</th><th className="num">Asking</th><th>Status</th></tr></thead>
            <tbody>
              {newest.map((v) => (
                <tr key={v.id}>
                  <td><Link href={`/vehicles/${v.id}`} className="row-link">{v.stockNumber}</Link></td>
                  <td>{carName(v)}</td>
                  <td className="num">{v.mileage === null || v.mileage === undefined ? "—" : `${v.mileage.toLocaleString("en-US")} mi`}</td>
                  <td className="num">{v.askingPrice === null || v.askingPrice === undefined ? "—" : whole(v.askingPrice)}</td>
                  <td>{VEHICLE_STATUS_TEXT[v.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

async function AgedCars({ ctx }: { ctx: Ctx }) {
  const aged = (await listVehicles(ctx, { status: "live" })).filter((v) => v.daysHeld >= 60).sort((a, b) => b.daysHeld - a.daysHeld).slice(0, 6);
  return (
    <section className="glass panel">
      <h2 className="title">Been here longest</h2>
      {aged.length === 0 ? (
        <p className="muted">Nothing has been on hand for 60 days or more.</p>
      ) : (
        <ul className="plain-list">
          {aged.map((v) => (
            <li key={v.id}><Link href={`/vehicles/${v.id}`} className="row-link">{carName(v)}</Link> <span className="muted">· {v.daysHeld} days</span></li>
          ))}
        </ul>
      )}
    </section>
  );
}

const TONE: Record<string, string> = { deal_owed: "warn", deal_ready: "ok", deal_paperwork: "warn", car_aged: "warn", car_no_price: "bad", car_draft: "info", car_recon: "info", car_no_title: "bad", form_8300: "bad", temp_tag: "warn", title_due: "warn", papers_missing: "info" };
/** The same list Ava's briefing works from: money owed, deals ready to deliver, paperwork gaps and stale cars. */
async function LotAttention({ ctx }: { ctx: Ctx }) {
  const list = await dealerAttention(ctx);
  return (
    <section className="glass panel">
      <div className="panel-head">
        <h2 className="title">Needs attention</h2>
        <span className="muted">{list.length} {list.length === 1 ? "item" : "items"}</span>
      </div>
      {list.length === 0 ? (
        <p className="muted">Nothing needs you right now.</p>
      ) : (
        <div className="rows scroll-rows">
          {list.map((item, i) => (
            <div className="row" key={i}>
              <span className={`dot dot-${TONE[item.kind] ?? "info"}`} aria-hidden="true" />
              <div className="row-text">
                <Link href={item.link} className="row-link row-title">{item.title}</Link>
                <div className="muted">{item.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

async function OpenDeals({ ctx }: { ctx: Ctx }) {
  const open = (await listDeals(ctx, { status: "open" })).slice(0, 8);
  return (
    <section className="glass panel">
      <div className="panel-head">
        <h2 className="title">Open deals</h2>
        <Link href="/deals" className="panel-link">All deals</Link>
      </div>
      {open.length === 0 ? (
        <p className="muted">No open deals. Start one from a vehicle on the lot.</p>
      ) : (
        <div className="table-wrap">
          <table className="compact">
            <thead><tr><th>Deal</th><th>Buyer</th><th>Vehicle</th><th className="num">Total</th><th className="num">Still owed</th></tr></thead>
            <tbody>
              {open.map((d) => (
                <tr key={d.id}>
                  <td><Link href={`/deals/${d.id}`} className="row-link">{d.number}</Link></td>
                  <td>{d.buyerName}</td>
                  <td>{d.vehicleName || d.stockNumber}</td>
                  <td className="num">{whole(d.total)}</td>
                  <td className="num">{d.balance > 0.005 ? whole(d.balance) : <span className="badge badge-ok">Paid</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The cards only a dealer Home has. Today and Calendar are shared with Clivada and drawn by its widgets. */
export const DEALER_CARDS: ReadonlySet<WidgetId> = new Set<WidgetId>(["lot-tiles", "dealer-sales", "dealer-deals", "lot-attention", "open-deals", "newest-cars", "aged-cars"]);

/** Draws one Dealer Terminal Home card, or null for a card that is not a dealer card. */
export function DealerWidget({ id, ctx, view }: { id: WidgetId; ctx: Ctx; view: DealerView }) {
  switch (id) {
    case "lot-tiles": return <LotTiles ctx={ctx} />;
    case "dealer-sales": return <DealerSalesChart ctx={ctx} choice={view} />;
    case "dealer-deals": return <DealCountChart ctx={ctx} choice={view} />;
    case "lot-attention": return <LotAttention ctx={ctx} />;
    case "open-deals": return <OpenDeals ctx={ctx} />;
    case "newest-cars": return <NewestCars ctx={ctx} />;
    case "aged-cars": return <AgedCars ctx={ctx} />;
    default: return null;
  }
}
