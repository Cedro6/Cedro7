import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { can, COST_KIND_TEXT, COST_KINDS, featureOn, getVehicle, listDealerFiles, listVehicleCosts, openDealFor, seesCost, VEHICLE_STATUS_TEXT, type VehicleStatus } from "@bos/core";
import { FileUpload } from "../../../../components/FileUpload";
import { formatMoney } from "../../../../lib/format";
import { OwnFields, SpecFields } from "../../../../components/VehicleFields";
import { currency, todayHere, whole } from "../../../../lib/locale";
import { requireSession } from "../../../../lib/session";
import { addCost, coverPhoto, deleteCost, saveVehicle, setVehicleStatus } from "../actions";
import { deleteFile } from "../../deals/actions";

const NEXT: Partial<Record<VehicleStatus, { to: VehicleStatus; label: string }[]>> = {
  draft: [{ to: "recon", label: "Into reconditioning" }, { to: "on_lot", label: "Put on the lot" }],
  recon: [{ to: "on_lot", label: "Put on the lot" }],
  on_lot: [{ to: "sold", label: "Mark sold" }, { to: "recon", label: "Back to reconditioning" }],
  sold: [{ to: "on_lot", label: "Not sold after all" }],
};

export default async function VehiclePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { ctx } = await requireSession();
  if (!featureOn(ctx.features, "dealer") || !can(ctx, "vehicle.read")) redirect("/");
  const { id } = await params;
  const { error, notice } = await searchParams;
  const car = await getVehicle(ctx, id);
  if (!car) notFound();
  const [deal, photos, costs] = await Promise.all([openDealFor(ctx, car.id), listDealerFiles(ctx, { vehicleId: car.id }), seesCost(ctx) ? listVehicleCosts(ctx, car.id) : Promise.resolve(null)]);
  const spent = costs ? Math.round(costs.reduce((n, c) => n + c.amount, 0) * 100) / 100 : 0;
  const allIn = car.acquisitionPrice === undefined || car.acquisitionPrice === null ? null : car.acquisitionPrice + spent;
  const write = can(ctx, "vehicle.write");
  const showCost = can(ctx, "product.cost.view");
  const name = [car.year, car.make, car.model, car.trim].filter(Boolean).join(" ") || "Vehicle";
  const save = saveVehicle.bind(null, car.id);
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow"><Link href="/vehicles">Vehicles</Link> · {car.stockNumber}</div>
          <h1>{name}</h1>
        </div>
        {deal ? (
          <Link href={`/deals/${deal.id}`} className="btn btn-primary">Open deal {deal.number}</Link>
        ) : write && car.status !== "sold" && car.status !== "removed" ? (
          <Link href={`/deals/new?vehicle=${car.id}`} className="btn btn-primary">Start a deal</Link>
        ) : null}
        <Link href={`/vehicles/${car.id}/sticker`} className="btn btn-glass">Window sticker</Link>
        <Link href={`/vehicles/${car.id}/buyers-guide`} className="btn btn-glass">Buyers Guide</Link>
        {write && (NEXT[car.status] ?? []).filter((step) => step.to !== "sold").map((step) => (
          <form key={step.to} action={setVehicleStatus.bind(null, car.id, step.to)}>
            <button type="submit" className="btn btn-glass">{step.label}</button>
          </form>
        ))}
        {write && car.status !== "removed" && car.status !== "sold" && (
          <form action={setVehicleStatus.bind(null, car.id, "removed")}>
            <button type="submit" className="btn btn-glass">Remove from lot</button>
          </form>
        )}
      </header>
      {error && <p className="error">{error}</p>}
      {notice && !error && <p className="notice">{notice}</p>}
      <div className="tiles">
        <div className="glass panel tile"><h2 className="label">Status</h2><div className="numeral numeral-small">{VEHICLE_STATUS_TEXT[car.status]}</div><div className="muted">{car.daysHeld} {car.daysHeld === 1 ? "day" : "days"} {car.status === "sold" ? "to sell" : "so far"}</div></div>
        <div className="glass panel tile"><h2 className="label">Mileage</h2><div className="numeral numeral-small">{car.mileage === undefined || car.mileage === null ? "—" : `${car.mileage.toLocaleString("en-US")} mi`}</div><div className="muted">{car.condition ? `Condition: ${car.condition}` : "Not graded"}</div></div>
        <div className="glass panel tile"><h2 className="label">Asking</h2><div className="numeral numeral-small">{car.askingPrice === undefined || car.askingPrice === null ? "—" : whole(car.askingPrice)}</div>
          {showCost && <div className="muted">{car.acquisitionPrice === undefined || car.acquisitionPrice === null ? "Cost not recorded" : `Paid ${whole(car.acquisitionPrice)}${car.askingPrice ? ` · ${whole(car.askingPrice - car.acquisitionPrice)} on top` : ""}`}</div>}
        </div>
        <div className="glass panel tile"><h2 className="label">VIN</h2><div className="numeral numeral-small mono">{car.vin ?? "None"}</div><div className="muted">{car.locationName ?? "No location"}</div></div>
      </div>
      <section className="glass panel" id="photos">
        <div className="panel-head">
          <div>
            <h2 className="title">Photos</h2>
            <p className="muted">The first photo is the cover on the window sticker and in the listing file. Photos are public by their link while the car is on the lot, so listing sites can show them.</p>
          </div>
          <span className="muted">{photos.length} {photos.length === 1 ? "photo" : "photos"}</span>
        </div>
        {photos.length > 0 && (
          <div className="photo-grid">
            {photos.map((ph, i) => (
              <figure key={ph.id} className="photo-card">
                <img src={`/files/${ph.id}`} alt={`${name}, photo ${i + 1}`} loading="lazy" />
                {i === 0 && <span className="badge photo-cover">Cover</span>}
                {write && (
                  <figcaption>
                    {i > 0 && <form action={coverPhoto.bind(null, car.id, ph.id)}><button type="submit" className="btn btn-glass btn-small">Make cover</button></form>}
                    <form action={deleteFile.bind(null, ph.id)}><button type="submit" className="btn btn-glass btn-small">Remove</button></form>
                  </figcaption>
                )}
              </figure>
            ))}
          </div>
        )}
        {photos.length === 0 && <p className="muted">No photos yet.</p>}
        {write && <FileUpload vehicleId={car.id} accept="image/*" label="Photos (choose several at once)" />}
      </section>

      {costs && (
        <section className="glass panel" id="costs">
          <div className="panel-head">
            <div>
              <h2 className="title">What this car cost</h2>
              <p className="muted">Reconditioning, parts, transport and fees spent after buying it. They come off the profit when it sells.</p>
            </div>
          </div>
          <div className="cost-total">
            <div><span className="label">Bought for</span><span className="numeral numeral-small">{car.acquisitionPrice === undefined || car.acquisitionPrice === null ? "—" : whole(car.acquisitionPrice)}</span></div>
            <div><span className="label">Spent since</span><span className="numeral numeral-small">{whole(spent)}</span></div>
            <div><span className="label">All in</span><span className="numeral numeral-small">{allIn === null ? "—" : whole(allIn)}</span></div>
            {allIn !== null && car.askingPrice ? <div><span className="label">Asking less all in</span><span className="numeral numeral-small">{whole(car.askingPrice - allIn)}</span></div> : null}
          </div>
          {costs.length > 0 && (
            <div className="table-wrap">
              <table className="compact">
                <thead><tr><th>Date</th><th>For</th><th>Note</th><th className="num">Amount</th><th>By</th><th><span className="sr-only">Remove</span></th></tr></thead>
                <tbody>
                  {costs.map((c) => (
                    <tr key={c.id}>
                      <td>{c.spentOn}</td><td>{COST_KIND_TEXT[c.kind]}</td><td>{c.description ?? "—"}</td><td className="num">{formatMoney(c.amount)}</td><td>{c.by ?? "—"}</td>
                      <td className="row-actions">{write && <form action={deleteCost.bind(null, car.id, c.id)}><button type="submit" className="btn btn-glass btn-small">Remove</button></form>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {write && (
            <form action={addCost.bind(null, car.id)} className="form-row">
              <label className="field"><span>For</span><select name="kind" defaultValue="recon">{COST_KINDS.map((k) => <option key={k} value={k}>{COST_KIND_TEXT[k]}</option>)}</select></label>
              <label className="field"><span>Note</span><input name="description" maxLength={200} placeholder="Brakes and rotors" /></label>
              <label className="field"><span>Amount</span><input name="amount" inputMode="decimal" required placeholder="0.00" /></label>
              <label className="field"><span>Date</span><input name="spentOn" type="date" required defaultValue={todayHere()} /></label>
              <div className="field"><span>&nbsp;</span><button type="submit" className="btn btn-primary">Add cost</button></div>
            </form>
          )}
        </section>
      )}

      <form action={save} className="stack-panels">
        <section className="glass panel">
          <div className="panel-head">
            <div>
              <h2 className="title">Specifications</h2>
              <p className="muted">Fields marked VIN came from the decoder. Anything you change is marked as typed.</p>
            </div>
          </div>
          <fieldset disabled={!write} className="veh-fieldset">
            <SpecFields values={car} provenance={car.provenance} />
          </fieldset>
          {Object.keys(car.specs).length > 0 && (
            <details className="veh-extra">
              <summary>Everything else the decoder knew ({Object.keys(car.specs).length})</summary>
              <dl className="veh-dl">
                {Object.entries(car.specs).map(([k, v]) => <div key={k}><dt>{k.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt><dd>{v}</dd></div>)}
              </dl>
            </details>
          )}
        </section>
        <section className="glass panel">
          <h2 className="title">About this car</h2>
          <fieldset disabled={!write} className="veh-fieldset">
            <OwnFields values={car} showCost={showCost} currency={currency()} />
          </fieldset>
        </section>
        {write && (
          <div className="actions">
            <button type="submit" className="btn btn-primary">Save changes</button>
          </div>
        )}
      </form>
    </>
  );
}
