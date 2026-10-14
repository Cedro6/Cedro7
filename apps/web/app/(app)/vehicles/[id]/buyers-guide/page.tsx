import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getCompanyProfile, getDealerSettings, getVehicle } from "@bos/core";
import { BackToVehicle } from "../../../../../components/BackToVehicle";
import { BuyersGuideSheet } from "../../../../../components/BuyersGuideSheet";
import { PrintButton } from "../../../../../components/PrintButton";
import { requireSession } from "../../../../../lib/session";

/**
 * The Buyers Guide for the window. The FTC Used Car Rule requires it on every used car offered for
 * sale, so it prints from the car itself; the deal prints the buyer's signed copy.
 */
export default async function VehicleBuyersGuidePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ warranty?: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "vehicle.read")) notFound();
  const { id } = await params;
  const warranty = (await searchParams).warranty === "dealer";
  const car = await getVehicle(ctx, id);
  if (!car) notFound();
  const [company, dealer] = await Promise.all([getCompanyProfile(ctx), getDealerSettings(ctx)]);
  return (
    <>
      <header className="page-head no-print">
        <div>
          <div className="eyebrow"><Link href="/vehicles">Vehicles</Link> / <Link href={`/vehicles/${id}`}>{car.stockNumber}</Link></div>
          <h1>Buyers Guide for the window</h1>
        </div>
        <div className="segmented" role="group" aria-label="Warranty">
          <Link href={`/vehicles/${id}/buyers-guide`} aria-current={!warranty ? "true" : undefined}>As is</Link>
          <Link href={`/vehicles/${id}/buyers-guide?warranty=dealer`} aria-current={warranty ? "true" : undefined}>Dealer warranty</Link>
        </div>
        <BackToVehicle id={id} stockNumber={car.stockNumber} />
        <PrintButton />
      </header>
      <BuyersGuideSheet car={{ make: car.make, model: car.model, year: car.year, vin: car.vin, stockNumber: car.stockNumber }} soldAsIs={!warranty} warrantyNote={null} company={company} dealer={dealer} signature={false} />
      <p className="muted footnote no-print">Print it and display it in a side window while the car is for sale. The deal prints the buyer&apos;s copy with the warranty chosen on the deal, for them to sign at closing.</p>
    </>
  );
}
