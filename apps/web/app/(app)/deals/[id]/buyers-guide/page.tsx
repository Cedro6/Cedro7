import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getCompanyProfile, getDeal, getDealerSettings } from "@bos/core";
import { BuyersGuideSheet } from "../../../../../components/BuyersGuideSheet";
import { BackToDeal } from "../../../../../components/BackToDeal";
import { PrintButton } from "../../../../../components/PrintButton";
import { requireSession } from "../../../../../lib/session";

/**
 * The FTC Buyers Guide, as the Used Car Rule lays it out: the warranty choice up front, the
 * vehicle, and the dealer. Printed and displayed in the window, then handed to the buyer.
 */
export default async function BuyersGuidePage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "vehicle.read")) notFound();
  const { id } = await params;
  const deal = await getDeal(ctx, id);
  if (!deal) notFound();
  const [company, dealer] = await Promise.all([getCompanyProfile(ctx), getDealerSettings(ctx)]);
  return (
    <>
      <header className="page-head no-print">
        <div>
          <div className="eyebrow"><Link href="/deals">Deals</Link> / <Link href={`/deals/${id}`}>{deal.number}</Link></div>
          <h1>Buyers Guide</h1>
        </div>
        <BackToDeal id={id} number={deal.number} />
        <PrintButton />
      </header>
      <BuyersGuideSheet
        car={{ make: deal.vehicleMake, model: deal.vehicleModel, year: deal.vehicleYear, vin: deal.vin, stockNumber: deal.stockNumber }}
        soldAsIs={deal.soldAsIs} warrantyNote={deal.warrantyNote} company={company} dealer={dealer}
      />
      <p className="muted footnote no-print">This page reproduces the FTC Used Car Rule&apos;s Buyers Guide wording. The Rule also requires the back page (major defects list), which you should print from the FTC&apos;s own form if the tag office or an inspector asks for it.</p>
    </>
  );
}
