import Link from "next/link";
import { dealSalesSeries, listReminders, listVehicles, lotSummary, VEHICLE_STATUS_TEXT, type ChartPeriod, type Ctx } from "@bos/core";
import { AreaChart } from "./home/charts";
import { todayHere, whole } from "../lib/locale";

const CHART: Record<ChartPeriod, { tab: string; title: string; empty: string }> = {
  "30d": { tab: "30 days", title: "Sales, last 30 days", empty: "No cars delivered in the last 30 days." },
  quarter: { tab: "Quarter", title: "Sales, this quarter", empty: "No cars delivered this quarter yet." },
  ytd: { tab: "Year to date", title: "Sales, year to date", empty: "No cars delivered this year yet." },
};
const shortDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The same chart as Cedro's Home, counting delivered deals. */
async function DealerSalesChart({ ctx, period }: { ctx: Ctx; period: ChartPeriod }) {
  const data = await dealSalesSeries(ctx, period);
  if (!data) return null;
  const text = CHART[data.period];
  const last = data.points.at(-1)?.total ?? 0;
  return (
    <section className="glass panel">
      <div className="panel-head">
        <div>
          <h2 className="title">{text.title}</h2>
          <div className="muted">{shortDay(data.from)} to {shortDay(data.to)} · deals delivered, sale price before tax and fees{data.bucket === "week" ? " · by week" : ""}</div>
        </div>
        <div className="segmented" role="group" aria-label="Chart period">
          {(["30d", "quarter", "ytd"] as const).map((p) => (
            <Link key={p} href={p === "30d" ? "/" : `/?chart=${p}`} aria-current={p === data.period ? "true" : undefined} scroll={false}>{CHART[p].tab}</Link>
          ))}
        </div>
      </div>
      <div className="chart-total">
        <span className="numeral numeral-md">{whole(data.total)}</span>
        <span className="muted">total · {data.cars} {data.cars === 1 ? "car" : "cars"} sold · {whole(last)} {data.bucket === "week" ? "this week" : "today"}</span>
      </div>
      {data.total > 0 && data.points.length > 1 ? (
        <AreaChart animate={data.period} series={data.points} label={`${text.title}: ${whole(data.total)} from ${data.cars} cars, shown ${data.bucket === "week" ? "week by week" : "day by day"}`} />
      ) : (
        <p className="muted">{text.empty}</p>
      )}
    </section>
  );
}

/** Home for a Dealer Terminal company: the lot at a glance, what is getting old, and what is due. */
export async function DealerHome({ ctx, period = "30d" }: { ctx: Ctx; period?: ChartPeriod }) {
  const [lot, vehicles, due] = await Promise.all([lotSummary(ctx), listVehicles(ctx, { status: "live" }), listReminders(ctx, { to: todayHere(), openOnly: true })]);
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
      <DealerSalesChart ctx={ctx} period={period} />
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
