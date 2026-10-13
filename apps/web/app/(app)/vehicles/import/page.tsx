import Link from "next/link";
import { redirect } from "next/navigation";
import { can, featureOn } from "@bos/core";
import { VinImportTool } from "../../../../components/VinImportTool";
import { requireSession } from "../../../../lib/session";

export default async function VehicleImportPage() {
  const { ctx } = await requireSession();
  if (!featureOn(ctx.features, "dealer") || !can(ctx, "vehicle.write")) redirect("/vehicles");
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow"><Link href="/vehicles">Vehicles</Link></div>
          <h1>Bulk import VINs</h1>
        </div>
      </header>
      <VinImportTool />
    </>
  );
}
