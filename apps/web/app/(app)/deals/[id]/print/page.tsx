import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getCompanyProfile, getDeal, getDealerSettings, ODOMETER_TEXT } from "@bos/core";
import { PaperBrand } from "../../../../../components/PaperBrand";
import { BackToDeal } from "../../../../../components/BackToDeal";
import { PrintButton } from "../../../../../components/PrintButton";
import { formatMoney } from "../../../../../lib/format";
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
      <section className="paper">
        <div className="paper-head">
          <PaperBrand company={company} />
          <div className="paper-title">
            Buyer&apos;s order{deal.status === "cancelled" ? " (cancelled)" : deal.status === "open" ? " (not yet delivered)" : ""}
            <div className="paper-muted mono">{deal.number} · {when}</div>
            {dealer.licence && <div className="paper-muted">Dealer licence {dealer.licence}</div>}
          </div>
        </div>
        <div className="paper-meta">
          <div>
            <div className="paper-label">Buyer</div>
            <div className="paper-strong">{deal.buyerName}{deal.coBuyerName ? ` and ${deal.coBuyerName}` : ""}</div>
            {deal.buyerAddress && <div>{deal.buyerAddress}</div>}
            {(deal.buyerCity || deal.buyerZip) && <div>{[deal.buyerCity, deal.buyerState, deal.buyerZip].filter(Boolean).join(" ")}</div>}
            {deal.buyerDl && <div className="paper-muted">DL {deal.buyerDl}</div>}
            {(deal.buyerPhone || deal.buyerEmail) && <div className="paper-muted">{[deal.buyerPhone, deal.buyerEmail].filter(Boolean).join(" · ")}</div>}
          </div>
          <div>
            <div className="paper-label">Vehicle</div>
            <div className="paper-strong">{deal.vehicleName || deal.stockNumber}</div>
            <div className="mono">VIN {deal.vin ?? "—"}</div>
            <div className="paper-muted">Stock {deal.stockNumber}</div>
            {deal.odometer !== null && <div className="paper-muted">Odometer {deal.odometer.toLocaleString("en-US")} · {ODOMETER_TEXT[deal.odometerBrand]}</div>}
          </div>
          {deal.tradeVin && (
            <div>
              <div className="paper-label">Trade-in</div>
              <div>{deal.tradeDescription ?? "Vehicle"}</div>
              <div className="mono">VIN {deal.tradeVin}</div>
              {deal.tradeMileage !== null && <div className="paper-muted">{deal.tradeMileage.toLocaleString("en-US")} miles</div>}
            </div>
          )}
        </div>
        <div className="paper-totals paper-totals-wide">
          <div><span>Sale price</span><span>{formatMoney(deal.salePrice)}</span></div>
          {deal.dealerFee > 0 && <div><span>Dealer fee</span><span>{formatMoney(deal.dealerFee)}</span></div>}
          {deal.tradeAllowance > 0 && <div><span>Trade-in allowance</span><span>−{formatMoney(deal.tradeAllowance)}</span></div>}
          <div><span>Taxable amount</span><span>{formatMoney(deal.taxable)}</span></div>
          <div><span>Florida sales tax ({deal.stateTaxPct}%)</span><span>{formatMoney(deal.stateTax)}</span></div>
          {deal.surtax > 0 && <div><span>County discretionary surtax ({deal.surtaxPct}% on the first {formatMoney(deal.surtaxCap)})</span><span>{formatMoney(deal.surtax)}</span></div>}
          {deal.tagTitleFees > 0 && <div><span>Tag, title and registration fees</span><span>{formatMoney(deal.tagTitleFees)}</span></div>}
          {deal.otherFees > 0 && <div><span>{deal.otherFeesNote || "Other fees"}</span><span>{formatMoney(deal.otherFees)}</span></div>}
          <div className="paper-total"><span>Total</span><span>{formatMoney(deal.total)}</span></div>
          <div><span>Paid</span><span>{formatMoney(deal.paid)}</span></div>
          <div className="paper-strong"><span>Balance due</span><span>{formatMoney(deal.balance)}</span></div>
        </div>
        {deal.dealerFee > 0 && (
          <p className="paper-note">
            This charge represents costs and profit to the dealer for items such as inspecting, cleaning, and adjusting vehicles, and preparing documents related to the sale.
          </p>
        )}
        <p className="paper-note">
          {deal.soldAsIs
            ? "This vehicle is sold AS IS, with no dealer warranty. The dealer makes no promises about its condition. See the Buyers Guide window form, which is part of this contract and overrides any contrary provisions in it."
            : `Dealer warranty: ${deal.warrantyNote ?? "see the Buyers Guide window form, which is part of this contract."}`}
        </p>
        <p className="paper-note">The buyer acknowledges the odometer statement above and receives the vehicle&apos;s title on delivery.{deal.notes ? ` ${deal.notes}` : ""}</p>
        <div className="paper-sign">
          <div><div className="sign-line" /><div className="paper-label">Buyer</div></div>
          {deal.coBuyerName && <div><div className="sign-line" /><div className="paper-label">Co-buyer</div></div>}
          <div><div className="sign-line" /><div className="paper-label">For {company.name}</div></div>
          <div><div className="sign-line" /><div className="paper-label">Date</div></div>
        </div>
      </section>
    </>
  );
}
