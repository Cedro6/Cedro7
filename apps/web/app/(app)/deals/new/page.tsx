import Link from "next/link";
import { redirect } from "next/navigation";
import { can, featureOn, getDealerSettings, getVehicle, listVehicles } from "@bos/core";
import { DealForm, type PickableVehicle } from "../../../../components/DealForm";
import { currency } from "../../../../lib/locale";
import { requireSession } from "../../../../lib/session";
import { newDeal } from "../actions";

export default async function NewDealPage({ searchParams }: { searchParams: Promise<{ vehicle?: string; error?: string }> }) {
  const { ctx } = await requireSession();
  if (!featureOn(ctx.features, "dealer") || !can(ctx, "vehicle.write")) redirect("/deals");
  const { vehicle: vehicleId, error } = await searchParams;
  const [settings, chosen, lot] = await Promise.all([getDealerSettings(ctx), vehicleId ? getVehicle(ctx, vehicleId) : null, listVehicles(ctx, { status: "live" })]);
  const pickable: PickableVehicle[] = lot.map((v) => ({ id: v.id, stockNumber: v.stockNumber, name: [v.year, v.make, v.model, v.trim].filter(Boolean).join(" "), vin: v.vin, askingPrice: v.askingPrice ?? null, mileage: v.mileage ?? null, status: v.status }));
  const picked = chosen && chosen.status !== "sold" && chosen.status !== "removed" ? pickable.find((p) => p.id === chosen.id) ?? null : null;
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow"><Link href="/deals">Deals</Link></div>
          <h1>New deal</h1>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      <DealForm
        action={newDeal} submitLabel="Start the deal" locked={false} currency={currency()} vehicles={pickable} chosen={picked}
        v={{ salePrice: picked?.askingPrice ?? undefined, dealerFee: settings.dealerFee, tagTitleFees: settings.tagTitleFees, stateTaxPct: 6, surtaxPct: settings.surtaxPct, odometer: picked?.mileage ?? undefined }}
      />
    </>
  );
}
