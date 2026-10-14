import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getCompanyProfile, getDeal, getDealerSettings, ODOMETER_TEXT } from "@bos/core";
import { BuyersOrderSheet } from "../../../../../components/BuyersOrderSheet";
import { BackToDeal } from "../../../../../components/BackToDeal";
import { PrintButton } from "../../../../../components/PrintButton";
import { zone } from "../../../../../lib/locale";
import { requireSession } from "../../../../../lib/session";

/** The buyer's order: what is being sold, for how much, and on what terms. Both sides sign it. */
export default async function BuyersOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "vehicle.read")) notFound();
  const { id } = await params;
  const deal = await getDeal(ctx, id);
  if (!deal) notFound();
  const [company, dealer] = await Promise.all([getCompanyProfile(ctx), getDealerSettings(ctx)]);
  const when = deal.deliveredOn ?? new Intl.DateTimeFormat("en-CA", { timeZone: zone() }).format(new Date());
  return (
    <>
      <header className="page-head no-print">
        <div>
          <div className="eyebrow"><Link href="/deals">Deals</Link> / <Link href={`/deals/${id}`}>{deal.number}</Link></div>
          <h1>Buyer&apos;s order</h1>
        </div>
        <BackToDeal id={id} number={deal.number} />
        <PrintButton />
      </header>
      {deal.status === "cancelled" && <p className="error no-print">This deal was cancelled.</p>}
      <BuyersOrderSheet deal={deal} company={company} dealer={dealer} when={when} odometerText={deal.odometer === null ? null : ODOMETER_TEXT[deal.odometerBrand]} />
    </>
  );
}
