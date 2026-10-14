import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getCompanyProfile, getDeal, getDealerSettings } from "@bos/core";
import { BackToDeal } from "../../../../../../components/BackToDeal";
import { PaperBrand } from "../../../../../../components/PaperBrand";
import { PrintButton } from "../../../../../../components/PrintButton";
import { formatMoney } from "../../../../../../lib/format";
import { requireSession } from "../../../../../../lib/session";

/** A receipt for one payment on a deal: what was paid, how, and what is still owed after it. */
export default async function PaymentReceiptPage({ params }: { params: Promise<{ id: string; payment: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "vehicle.read")) notFound();
  const { id, payment } = await params;
  const deal = await getDeal(ctx, id);
  const index = deal?.payments.findIndex((p) => p.id === payment) ?? -1;
  if (!deal || index < 0) notFound();
  const p = deal.payments[index]!;
  const paidSoFar = deal.payments.slice(0, index + 1).reduce((n, x) => n + x.amount, 0);
  const balance = Math.max(0, Math.round((deal.total - paidSoFar) * 100) / 100);
  const [company, dealer] = await Promise.all([getCompanyProfile(ctx), getDealerSettings(ctx)]);
  const receiptNo = `${deal.number}-${String(index + 1).padStart(2, "0")}`;
  return (
    <>
      <header className="page-head no-print">
        <div>
          <div className="eyebrow"><Link href="/deals">Deals</Link> / <Link href={`/deals/${id}`}>{deal.number}</Link></div>
          <h1>Payment receipt</h1>
        </div>
        <BackToDeal id={id} number={deal.number} />
        <PrintButton />
      </header>
      <section className="paper">
        <div className="paper-head">
          <PaperBrand company={company} />
          <div className="paper-title">
            Receipt
            <div className="paper-muted mono">No. {receiptNo} · {p.paidOn}</div>
            {dealer.licence && <div className="paper-muted">Dealer licence {dealer.licence}</div>}
          </div>
        </div>
        <div className="paper-meta">
          <div>
            <div className="paper-label">Received from</div>
            <div className="paper-strong">{deal.buyerName}{deal.coBuyerName ? ` and ${deal.coBuyerName}` : ""}</div>
            {deal.buyerAddress && <div>{deal.buyerAddress}</div>}
            {(deal.buyerCity || deal.buyerZip) && <div>{[deal.buyerCity, deal.buyerState, deal.buyerZip].filter(Boolean).join(" ")}</div>}
          </div>
          <div>
            <div className="paper-label">Toward</div>
            <div className="paper-strong">{deal.vehicleName || deal.stockNumber}</div>
            <div className="mono">VIN {deal.vin ?? "—"}</div>
            <div className="paper-muted">Stock {deal.stockNumber} · Deal {deal.number}</div>
          </div>
        </div>
        <table className="paper-table">
          <tbody>
            <tr><th>Amount received</th><td className="num paper-strong">{formatMoney(p.amount)}</td></tr>
            <tr><th>Paid by</th><td className="num">{p.method}{p.reference ? ` · ${p.reference}` : ""}</td></tr>
            <tr><th>Deal total</th><td className="num">{formatMoney(deal.total)}</td></tr>
            <tr><th>Paid to date, with this payment</th><td className="num">{formatMoney(paidSoFar)}</td></tr>
            <tr><th>Balance still owed</th><td className="num paper-strong">{formatMoney(balance)}</td></tr>
          </tbody>
        </table>
        {deal.status === "cancelled" && <p className="paper-muted">This deal was later cancelled.</p>}
        <div className="paper-sign">
          <div><div className="sign-line" /><div className="paper-label">Received by, for {company.name}</div></div>
          <div><div className="sign-line" /><div className="paper-label">Date</div></div>
        </div>
      </section>
    </>
  );
}
