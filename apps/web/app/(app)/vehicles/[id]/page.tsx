import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { can, featureOn, getVehicle, openDealFor, VEHICLE_STATUS_TEXT, type VehicleStatus } from "@bos/core";
import { OwnFields, SpecFields } from "../../../../components/VehicleFields";
import { currency, whole } from "../../../../lib/locale";
import { requireSession } from "../../../../lib/session";
import { saveVehicle, setVehicleStatus } from "../actions";

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
  const deal = await openDealFor(ctx, car.id);
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
