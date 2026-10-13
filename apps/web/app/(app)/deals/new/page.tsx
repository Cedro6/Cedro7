import Link from "next/link";
import { redirect } from "next/navigation";
import { can, featureOn, getDealerSettings, getVehicle, listVehicles } from "@bos/core";
import { DealFields } from "../../../../components/DealFields";
import { currency } from "../../../../lib/locale";
import { requireSession } from "../../../../lib/session";
import { newDeal } from "../actions";

export default async function NewDealPage({ searchParams }: { searchParams: Promise<{ vehicle?: string; error?: string }> }) {
  const { ctx } = await requireSession();
  if (!featureOn(ctx.features, "dealer") || !can(ctx, "vehicle.write")) redirect("/deals");
  const { vehicle: vehicleId, error } = await searchParams;
  const [settings, chosen, lot] = await Promise.all([getDealerSettings(ctx), vehicleId ? getVehicle(ctx, vehicleId) : null, listVehicles(ctx, { status: "live" })]);
  const forSale = lot.filter((v) => v.status !== "removed");
  const name = (v: { year?: number; make?: string; model?: string; trim?: string; stockNumber: string }) => `${v.stockNumber} · ${[v.year, v.make, v.model, v.trim].filter(Boolean).join(" ") || "details to come"}`;
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow"><Link href="/deals">Deals</Link></div>
          <h1>New deal</h1>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      <form action={newDeal} className="stack-panels">
        <section className="glass panel">
          <h2 className="title">Vehicle</h2>
          {chosen && chosen.status !== "sold" && chosen.status !== "removed" ? (
            <>
              <input type="hidden" name="vehicleId" value={chosen.id} />
              <p>{name(chosen)}{chosen.vin ? <span className="muted mono"> · {chosen.vin}</span> : null}{chosen.askingPrice ? <span className="muted"> · asking {currency()} {chosen.askingPrice.toLocaleString("en-US")}</span> : null}</p>
            </>
          ) : (
            <label className="field">
              <span>Which car</span>
              <select name="vehicleId" required defaultValue="">
                <option value="" disabled>Choose a vehicle on the lot</option>
                {forSale.map((v) => <option key={v.id} value={v.id}>{name(v)}</option>)}
              </select>
            </label>
          )}
        </section>
        <DealFields v={{ salePrice: chosen?.askingPrice ?? undefined, dealerFee: settings.dealerFee, tagTitleFees: settings.tagTitleFees, stateTaxPct: 6, surtaxPct: settings.surtaxPct, odometer: chosen?.mileage ?? undefined }} currency={currency()} locked={false} />
        <div className="actions">
          <button type="submit" className="btn btn-primary">Start the deal</button>
          <Link href="/deals" className="btn btn-glass">Cancel</Link>
        </div>
        <p className="muted footnote">Nothing is sold yet. You can change any of this until the deal is delivered.</p>
      </form>
    </>
  );
}
