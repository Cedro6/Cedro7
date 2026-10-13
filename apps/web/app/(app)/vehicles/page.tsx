import Link from "next/link";
import { redirect } from "next/navigation";
import { can, featureOn, isVehicleStatus, listVehicles, lotSummary, VEHICLE_STATUS_TEXT, type VehicleStatus } from "@bos/core";
import { SearchIcon } from "../../../components/icons";
import { currency, whole } from "../../../lib/locale";
import { requireSession } from "../../../lib/session";

const FILTERS: { key: VehicleStatus | "live" | "sold"; label: string }[] = [
  { key: "live", label: "On hand" }, { key: "on_lot", label: "On the lot" }, { key: "recon", label: "In recon" }, { key: "draft", label: "Drafts" }, { key: "sold", label: "Sold" },
];

export default async function VehiclesPage({ searchParams }: { searchParams: Promise<{ q?: string; show?: string; notice?: string }> }) {
  const { ctx } = await requireSession();
  if (!featureOn(ctx.features, "dealer") || !can(ctx, "vehicle.read")) redirect("/");
  const params = await searchParams;
  const q = params.q?.trim() ?? "";
  const show = params.show === "live" || isVehicleStatus(params.show ?? "") ? (params.show as VehicleStatus | "live") : "live";
  const [vehicles, lot] = await Promise.all([listVehicles(ctx, { status: q ? undefined : show, search: q }), lotSummary(ctx)]);
  const write = can(ctx, "vehicle.write");
  const miles = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toLocaleString("en-US")} mi`);
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">Dealer Terminal</div>
          <h1>Vehicles</h1>
        </div>
        <form className="glass search" role="search">
          <SearchIcon />
          <label className="sr-only" htmlFor="q">Search vehicles</label>
          <input id="q" name="q" type="search" placeholder="Stock number, VIN, make or model" defaultValue={q} />
        </form>
        {write && (
          <>
            <Link href="/vehicles/import" className="btn btn-glass">Bulk import VINs</Link>
            <Link href="/vehicles/new" className="btn btn-primary">Add vehicle by VIN</Link>
          </>
        )}
      </header>
      {params.notice && <p className="notice">{params.notice}</p>}
      <div className="tiles">
        <Link href="/vehicles?show=on_lot" className="glass panel tile"><h2 className="label">On the lot</h2><div className="numeral">{lot.onLot}</div><div className="muted">{lot.recon} in reconditioning · {lot.draft} drafts</div></Link>
        <div className="glass panel tile"><h2 className="label">Over 60 days</h2><div className="numeral">{lot.aged}</div><div className="muted">{lot.aged === 0 ? "Nothing is getting old" : "Worth a price review"}</div></div>
        {lot.invested !== null && <div className="glass panel tile"><h2 className="label">Invested in stock</h2><div className="numeral">{whole(lot.invested)}</div><div className="muted">What you paid for the {lot.live} on hand</div></div>}
      </div>
      {!q && (
        <nav className="segmented rpt-tabs" aria-label="Show">
          {FILTERS.map((f) => (
            <Link key={f.key} href={`/vehicles?show=${f.key}`} aria-current={show === f.key ? "page" : undefined}>{f.label}</Link>
          ))}
        </nav>
      )}
      <section className="glass panel">
        {vehicles.length === 0 ? (
          <div className="empty">
            <div className="empty-title">{q ? "No vehicles match that search" : lot.live === 0 ? "No vehicles yet" : "Nothing here"}</div>
            <p>{q ? "Try the stock number, part of the VIN, or the make." : lot.live === 0 ? "Add your first car by its VIN. The VIN fills in the year, make, model and specifications; you add the mileage and what you paid." : "Try another filter."}</p>
            {write && lot.live === 0 && !q && <p><Link href="/vehicles/new" className="btn btn-primary">Add vehicle by VIN</Link></p>}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Stock #</th><th>Vehicle</th><th>VIN</th><th className="num">Mileage</th><th className="num">Asking</th><th className="num">Days</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v) => (
                  <tr key={v.id}>
                    <td><Link href={`/vehicles/${v.id}`} className="row-link">{v.stockNumber}</Link></td>
                    <td>{[v.year, v.make, v.model, v.trim].filter(Boolean).join(" ") || <span className="muted">Details to come</span>}{v.colour ? <span className="muted"> · {v.colour}</span> : null}</td>
                    <td className="mono">{v.vin ?? "—"}</td>
                    <td className="num">{miles(v.mileage)}</td>
                    <td className="num">{v.askingPrice === null || v.askingPrice === undefined ? "—" : whole(v.askingPrice)}</td>
                    <td className="num">{v.daysHeld}</td>
                    <td><span className={`badge ${v.status === "on_lot" ? "badge-ok" : v.status === "sold" ? "badge-muted" : v.status === "recon" ? "badge-warn" : "badge-info"}`}>{VEHICLE_STATUS_TEXT[v.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="muted footnote">Prices in {currency()}. Days count from when the record was made.</p>
    </>
  );
}
