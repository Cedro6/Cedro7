import Link from "next/link";
import { redirect } from "next/navigation";
import { can, featureOn } from "@bos/core";
import { AddByVin } from "../../../../components/AddByVin";
import { currency } from "../../../../lib/locale";
import { requireSession } from "../../../../lib/session";

export default async function NewVehiclePage({ searchParams }: { searchParams: Promise<{ manual?: string }> }) {
  const { ctx } = await requireSession();
  if (!featureOn(ctx.features, "dealer") || !can(ctx, "vehicle.write")) redirect("/vehicles");
  const manual = (await searchParams).manual === "1";
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow"><Link href="/vehicles">Vehicles</Link></div>
          <h1>{manual ? "Add a vehicle by hand" : "Add vehicle by VIN"}</h1>
        </div>
      </header>
      <AddByVin showCost={can(ctx, "product.cost.view")} currency={currency()} manual={manual} />
    </>
  );
}
