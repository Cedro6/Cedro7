import Link from "next/link";
import { listReminders, listVehicles, lotSummary, VEHICLE_STATUS_TEXT, type Ctx } from "@bos/core";
import { todayHere, whole } from "../lib/locale";

/** Home for a Dealer Terminal company: the lot at a glance, what is getting old, and what is due. */
export async function DealerHome({ ctx }: { ctx: Ctx }) {
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
      <div className="dash">
        <section className="glass panel dash-item dash-wide">
          <div className="panel-head">
            <h2 className="title">Newest on the lot</h2>
            <Link href="/vehicles/new" className="btn btn-primary btn-small">Add vehicle by VIN</Link>
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
