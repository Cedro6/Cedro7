import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getCompanyProfile, getDeal, getDealerSettings, ODOMETER_TEXT } from "@bos/core";
import { BackToDeal } from "../../../../../components/BackToDeal";
import { BuyersGuideSheet } from "../../../../../components/BuyersGuideSheet";
import { BuyersOrderSheet } from "../../../../../components/BuyersOrderSheet";
import { PrintButton } from "../../../../../components/PrintButton";
import { FLORIDA_FORMS, formsForDeal } from "../../../../../lib/florida-forms";
import { requireSession } from "../../../../../lib/session";

/**
 * Every document for one deal in one place. The two we lay out ourselves print together from here;
 * the state's own forms are joined into a single PDF, because a browser cannot print a PDF and a web
 * page in the same run.
 */
export default async function DealDocumentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "vehicle.read")) notFound();
  const { id } = await params;
  const deal = await getDeal(ctx, id);
  if (!deal) notFound();
  const [company, dealer] = await Promise.all([getCompanyProfile(ctx), getDealerSettings(ctx)]);
  const forms = formsForDeal(deal);
  const missing = [
    !deal.buyerAddress && "buyer's address",
    !deal.buyerDl && "licence number",
    !deal.buyerDob && "date of birth",
    !deal.buyerSex && "sex",
    !deal.buyerCounty && "county",
    deal.odometer === null && "odometer reading",
    !deal.titleNumber && "the car's title number",
  ].filter(Boolean) as string[];
  return (
    <>
      <header className="page-head no-print">
        <div>
          <div className="eyebrow"><Link href="/deals">Deals</Link> / <Link href={`/deals/${id}`}>{deal.number}</Link></div>
          <h1>All documents</h1>
        </div>
        <BackToDeal id={id} number={deal.number} />
        <a href={`/deals/${id}/forms/all`} className="btn btn-glass" target="_blank" rel="noreferrer">Open the {forms.length} state forms</a>
        <PrintButton label="Print these two" />
      </header>
      {missing.length > 0 && <p className="notice no-print">The state forms are still missing {missing.join(", ")}. Fill those in on the deal first, or write them on by hand.</p>}
      <p className="muted no-print">
        Printing happens in two goes, because a browser cannot print a web page and a PDF together.
        First <strong>Print these two</strong> for the buyer&apos;s order and the Buyers Guide, then <strong>Open the {forms.length} state forms</strong> and print that PDF: {forms.map((f) => FLORIDA_FORMS[f].title.replace(/^.*\(HSMV /, "HSMV ").replace(/\)$/, "")).join(", ")}.
      </p>
      <BuyersOrderSheet deal={deal} company={company} dealer={dealer} odometerText={deal.odometer === null ? null : ODOMETER_TEXT[deal.odometerBrand]} />
      <div className="page-break" aria-hidden="true" />
      <BuyersGuideSheet
        car={{ make: deal.vehicleMake, model: deal.vehicleModel, year: deal.vehicleYear, vin: deal.vin, stockNumber: deal.stockNumber }}
        soldAsIs={deal.soldAsIs} warrantyNote={deal.warrantyNote} company={company} dealer={dealer}
      />
    </>
  );
}
