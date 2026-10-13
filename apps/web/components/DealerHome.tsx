import Link from "next/link";
import { dealSeries, DEALER_PERIODS, listReminders, listVehicles, lotSummary, VEHICLE_STATUS_TEXT, type Ctx, type DealerPeriod, type DealSeries } from "@bos/core";
import { AreaChart, CountBars } from "./home/charts";
import { todayHere, whole } from "../lib/locale";

const PERIOD: Record<DealerPeriod, { tab: string; words: string }> = {
  "7d": { tab: "7 days", words: "last 7 days" },
  "30d": { tab: "30 days", words: "last 30 days" },
  quarter: { tab: "Quarter", words: "this quarter" },
  ytd: { tab: "Year to date", words: "year to date" },
  "12m": { tab: "12 months", words: "last 12 months" },
};
const shortDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const shortMonth = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
/** The dates a chart covers, with the year when it starts in an earlier one. */
const span = (d: DealSeries) => (d.from.slice(0, 4) === d.to.slice(0, 4) ? `${shortDay(d.from)} to ${shortDay(d.to)}` : `${shortDay(d.from)}, ${d.from.slice(0, 4)} to ${shortDay(d.to)}, ${d.to.slice(0, 4)}`);
const BUCKET = { day: ["by day", "today"], week: ["by week", "this week"], month: ["by month", "this month"] } as const;

/** Each chart keeps its own period in the address, and the other chart's choice with it. */
type Choice = { sales: DealerPeriod; deals: DealerPeriod };
const homeHref = (choice: Choice, change: Partial<Choice>) => {
  const next = { ...choice, ...change };
  const parts = [next.sales !== "30d" ? `chart=${next.sales}` : "", next.deals !== "30d" ? `deals=${next.deals}` : ""].filter(Boolean);
  return parts.length ? `/?${parts.join("&")}` : "/";
};

function Periods({ choice, which, label }: { choice: Choice; which: keyof Choice; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {DEALER_PERIODS.map((p) => (
        <Link key={p} href={homeHref(choice, { [which]: p })} aria-current={p === choice[which] ? "true" : undefined} scroll={false}>{PERIOD[p].tab}</Link>
      ))}
    </div>
  );
}

/** The same sales chart as Cedro's Home: the money from cars delivered, drawn even when nothing has sold yet. */
function DealerSalesChart({ data, choice }: { data: DealSeries; choice: Choice }) {
  const last = data.points.at(-1)?.total ?? 0;
  const [by, now] = BUCKET[data.bucket];
  const tick = data.bucket === "month" ? shortMonth : shortDay;
  return (
    <section className="glass panel">
      <div className="panel-head">
        <div>
          <h2 className="title">Sales, {PERIOD[data.period].words}</h2>
          <div className="muted">{span(data)} · cars delivered, sale price before tax and fees · {by}</div>
        </div>
        <Periods choice={choice} which="sales" label="Sales chart period" />
      </div>
      <div className="chart-total">
        <span className="numeral numeral-md">{whole(data.total)}</span>
        <span className="muted">total · {data.cars} {data.cars === 1 ? "car" : "cars"} delivered · {whole(last)} {now}</span>
      </div>
      <AreaChart animate={`s${data.period}`} series={data.points} tick={tick} label={`Sales, ${PERIOD[data.period].words}: ${whole(data.total)} from ${data.cars} cars delivered, shown ${by}`} />
      {data.total === 0 && <p className="muted">No cars delivered in this period yet. A sale shows here on the day its deal is delivered.</p>}
    </section>
  );
}

/** How many deals were written, with how many of those are still open, beside the sales chart. */
function DealCountChart({ data, choice }: { data: DealSeries; choice: Choice }) {
  const [by] = BUCKET[data.bucket];
  const tick = data.bucket === "month" ? shortMonth : shortDay;
  return (
    <section className="glass panel">
      <div className="panel-head">
        <div>
          <h2 className="title">Deals, {PERIOD[data.period].words}</h2>
          <div className="muted">{span(data)} · deals written, cancelled left out · {by}</div>
        </div>
        <Periods choice={choice} which="deals" label="Deals chart period" />
      </div>
      <div className="chart-total">
        <span className="numeral numeral-md">{data.deals}</span>
        <span className="muted">{data.deals === 1 ? "deal" : "deals"} written · {data.deals - data.open} delivered · {data.open} still open</span>
      </div>
      <CountBars animate={`d${data.period}`} series={data.points.map((p) => ({ date: p.date, count: p.deals }))} tick={tick} label={`Deals ${PERIOD[data.period].words}: ${data.deals} written, ${data.open} still open, shown ${by}`} />
      {data.deals === 0 && <p className="muted">No deals written in this period yet.</p>}
    </section>
  );
}

/** Home for a Dealer Terminal company: the lot at a glance, what is getting old, and what is due. */
export async function DealerHome({ ctx, sales = "30d", deals = "30d" }: { ctx: Ctx; sales?: DealerPeriod; deals?: DealerPeriod }) {
  const choice = { sales, deals };
  const [lot, vehicles, due, salesData, dealsData] = await Promise.all([
    lotSummary(ctx), listVehicles(ctx, { status: "live" }), listReminders(ctx, { to: todayHere(), openOnly: true }), dealSeries(ctx, sales), dealSeries(ctx, deals),
  ]);
  const aged = vehicles.filter((v) => v.daysHeld >= 60).sort((a, b) => b.daysHeld - a.daysHeld).slice(0, 5);
  const newest = vehicles.slice(0, 6);
  const name = (v: (typeof vehicles)[number]) => [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ") || v.stockNumber;
  return (
    <>
      <div className="tiles">
        <Link href="/vehicles?show=on_lot" className="glass panel tile"><h2 className="label">On the lot</h2><div className="numeral">{lot.onLot}</div><div className="muted">{lot.recon} in reconditioning · {lot.draft} drafts</div></Link>
        <Link href="/vehicles" className="glass panel tile"><h2 className="label">Over 60 days</h2><div className="numeral">{lot.aged}</div><div className="muted">{lot.aged === 0 ? "Nothing is getting old" : "Worth a price review"}</div></Link>
        {lot.invested !== null && <div className="glass panel tile"><h2 className="label">Invested in stock</h2><div className="numeral">{whole(lot.invested)}</div><div className="muted">What you paid for the {lot.live} on hand</div></div>}
        <Link href="/calendar" className="glass panel tile"><h2 className="label">Due today</h2><div className="numeral">{due.length}</div><div className="muted">{due.length === 0 ? "No reminders due" : `${due.filter((r) => r.overdue).length} overdue`}</div></Link>
      </div>
      {salesData && dealsData && (
        <div className="chart-pair">
          <DealerSalesChart data={salesData} choice={choice} />
          <DealCountChart data={dealsData} choice={choice} />
        </div>
      )}
      <div className="dash">
        <section className="glass panel dash-item dash-wide">
          <div className="panel-head">
            <h2 className="title">Newest on the lot</h2>
            <Link href="/vehicles" className="row-link">All vehicles</Link>
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
                      <td>{name(v)}</td>
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
        <section className="glass panel dash-item dash-half">
          <h2 className="title">Been here longest</h2>
          {aged.length === 0 ? (
            <p className="muted">Nothing has been on hand for 60 days or more.</p>
          ) : (
            <ul className="plain-list">
              {aged.map((v) => (
                <li key={v.id}><Link href={`/vehicles/${v.id}`} className="row-link">{name(v)}</Link> <span className="muted">· {v.daysHeld} days</span></li>
              ))}
            </ul>
          )}
        </section>
        <section className="glass panel dash-item dash-half">
          <h2 className="title">Due today</h2>
          {due.length === 0 ? (
            <p className="muted">No reminders due. Ava can set one for you.</p>
          ) : (
            <ul className="plain-list">
              {due.slice(0, 6).map((r) => (
                <li key={r.id}>{r.title}{r.customerName ? <span className="muted"> · {r.customerName}</span> : null}{r.overdue ? <span className="badge badge-bad"> overdue</span> : null}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
