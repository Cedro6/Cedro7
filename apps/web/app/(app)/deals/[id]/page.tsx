import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { can, featureOn, getDeal, PAYMENT_METHODS } from "@bos/core";
import { DealFields } from "../../../../components/DealFields";
import { currency, todayHere, whole } from "../../../../lib/locale";
import { formatMoney } from "../../../../lib/format";
import { requireSession } from "../../../../lib/session";
import { cancel, deliver, saveDeal, takePayment } from "../actions";
import { FLORIDA_FORMS } from "../../../../lib/florida-forms";

export default async function DealPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { ctx } = await requireSession();
  if (!featureOn(ctx.features, "dealer") || !can(ctx, "vehicle.read")) redirect("/");
  const { id } = await params;
  const { error, notice } = await searchParams;
  const deal = await getDeal(ctx, id);
  if (!deal) notFound();
  const write = can(ctx, "vehicle.write") && deal.status === "open";
  const paid = deal.balance <= 0.005;
  const ready = paid && Boolean(deal.buyerAddress && deal.buyerCity && deal.buyerZip) && deal.odometer !== null;
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow"><Link href="/deals">Deals</Link> · {deal.number} · <Link href={`/vehicles/${deal.vehicleId}`}>{deal.stockNumber}</Link></div>
          <h1>{deal.buyerName}: {deal.vehicleName || deal.stockNumber}</h1>
        </div>
        <Link href={`/deals/${deal.id}/print`} className="btn btn-glass">Buyer&apos;s order</Link>
        {deal.status === "open" && can(ctx, "vehicle.write") && (
          <form action={deliver.bind(null, deal.id)} className="deal-deliver">
            <input type="hidden" name="deliveredOn" value={todayHere()} />
            <button type="submit" className="btn btn-primary" disabled={!ready} title={ready ? "" : "Paid in full, buyer's address and odometer reading are needed first"}>Deliver</button>
          </form>
        )}
      </header>
      {error && <p className="error">{error}</p>}
      {notice && !error && <p className="notice">{notice}</p>}
      {deal.status === "cancelled" && <p className="error">Cancelled: {deal.cancelledReason}</p>}
      {deal.status === "delivered" && <p className="notice">Delivered on {deal.deliveredOn}. The paperwork is below.</p>}

      <div className="tiles">
        <div className="glass panel tile"><h2 className="label">Total</h2><div className="numeral numeral-small">{whole(deal.total)}</div><div className="muted">{whole(deal.salePrice)} price · {formatMoney(deal.stateTax + deal.surtax)} tax · {formatMoney(deal.dealerFee + deal.tagTitleFees + deal.otherFees)} fees</div></div>
        <div className="glass panel tile"><h2 className="label">{paid ? "Paid in full" : "Still owed"}</h2><div className="numeral numeral-small">{whole(paid ? deal.paid : deal.balance)}</div><div className="muted">{deal.payments.length} {deal.payments.length === 1 ? "payment" : "payments"} recorded</div></div>
        {deal.gross !== null && <div className="glass panel tile"><h2 className="label">Gross on this car</h2><div className="numeral numeral-small">{whole(deal.gross)}</div><div className="muted">Price plus dealer fee, less what it cost</div></div>}
        <div className="glass panel tile"><h2 className="label">Status</h2><div className="numeral numeral-small">{deal.status === "open" ? (paid ? "Ready to deliver" : "Open") : deal.status === "delivered" ? "Delivered" : "Cancelled"}</div><div className="muted">{deal.odometer === null ? "Odometer reading needed" : `${deal.odometer.toLocaleString("en-US")} mi at sale`}</div></div>
      </div>

      <section className="glass panel">
        <h2 className="title">How the total is made up</h2>
        <div className="deal-sum">
          <div><span>Sale price</span><span>{formatMoney(deal.salePrice)}</span></div>
          {deal.dealerFee > 0 && <div><span>Dealer fee</span><span>{formatMoney(deal.dealerFee)}</span></div>}
          {deal.tradeAllowance > 0 && <div><span>Less trade-in allowance</span><span>−{formatMoney(deal.tradeAllowance)}</span></div>}
          <div className="deal-sub"><span>Taxable amount</span><span>{formatMoney(deal.taxable)}</span></div>
          <div><span>Florida sales tax {deal.stateTaxPct}%</span><span>{formatMoney(deal.stateTax)}</span></div>
          {deal.surtaxPct > 0 && <div><span>County surtax {deal.surtaxPct}% on the first {formatMoney(deal.surtaxCap)}</span><span>{formatMoney(deal.surtax)}</span></div>}
          {deal.tagTitleFees > 0 && <div><span>Tag, title and registration</span><span>{formatMoney(deal.tagTitleFees)}</span></div>}
          {deal.otherFees > 0 && <div><span>{deal.otherFeesNote || "Other fees"}</span><span>{formatMoney(deal.otherFees)}</span></div>}
          <div className="deal-total"><span>Total</span><span>{formatMoney(deal.total)}</span></div>
          <div><span>Paid</span><span>−{formatMoney(deal.paid)}</span></div>
          <div className="deal-total"><span>Balance</span><span>{formatMoney(deal.balance)}</span></div>
        </div>
      </section>

      {deal.status !== "cancelled" && (
        <section className="glass panel">
          <div className="panel-head">
            <div>
              <h2 className="title">Compliance paperwork</h2>
              <p className="muted">Filled from this deal. Print each one, check it, and have the buyer sign. Nothing is filed by the site; take the signed forms to the tag office.</p>
            </div>
          </div>
          {(!deal.titleNumber || !deal.buyerDl || !deal.buyerDob || !deal.buyerSex || !deal.buyerCounty || deal.odometer === null || !deal.buyerAddress) && (
            <p className="notice">
              Still missing for the forms: {[!deal.buyerAddress && "buyer's address", !deal.buyerDl && "buyer's licence number", !deal.buyerDob && "date of birth", !deal.buyerSex && "sex", !deal.buyerCounty && "county of residence", deal.odometer === null && "odometer reading", !deal.titleNumber && "the vehicle's title number (on the vehicle's page)"].filter(Boolean).join(", ")}.
            </p>
          )}
          <ul className="comp-list">
            <li>
              <div><strong>Buyers Guide (FTC window form)</strong><div className="muted">Required on every used car. Print it, display it in the window, and give the buyer a copy.</div></div>
              <Link href={`/deals/${deal.id}/buyers-guide`} className="btn btn-glass btn-small" target="_blank">Open</Link>
            </li>
            {Object.entries(FLORIDA_FORMS).map(([key, f]) => (
              <li key={key}>
                <div><strong>{f.title}</strong><div className="muted">{f.about}</div></div>
                <a href={`/deals/${deal.id}/forms/${key}`} className="btn btn-glass btn-small" target="_blank" rel="noreferrer">Fill and open</a>
              </li>
            ))}
          </ul>
          <p className="muted footnote">These are the state's current forms, filled in their own fields. Tax rates, fees and form versions change; the dealership is responsible for checking each form before it is signed.</p>
        </section>
      )}
      {deal.status !== "cancelled" && (
        <section className="glass panel">
          <div className="panel-head">
            <div>
              <h2 className="title">Payments</h2>
              <p className="muted">A cash sale is delivered paid in full. Record each amount as it comes in.</p>
            </div>
          </div>
          {deal.payments.length > 0 && (
            <div className="table-wrap">
              <table className="compact">
                <thead><tr><th>Date</th><th>How</th><th>Reference</th><th className="num">Amount</th><th>By</th></tr></thead>
                <tbody>{deal.payments.map((p) => <tr key={p.id}><td>{p.paidOn}</td><td>{p.method}</td><td>{p.reference ?? "—"}</td><td className="num">{formatMoney(p.amount)}</td><td>{p.recordedBy ?? "—"}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          {write && !paid && (
            <form action={takePayment.bind(null, deal.id)} className="form-row deal-pay">
              <label className="field"><span>Amount</span><input name="amount" inputMode="decimal" required defaultValue={deal.balance.toFixed(2)} /></label>
              <label className="field"><span>How</span><select name="method" defaultValue="Cash">{PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}</select></label>
              <label className="field"><span>Reference</span><input name="reference" maxLength={100} placeholder="Check no., last 4…" /></label>
              <label className="field"><span>Date</span><input name="paidOn" type="date" required defaultValue={todayHere()} /></label>
              <div className="field"><span>&nbsp;</span><button type="submit" className="btn btn-primary">Record payment</button></div>
            </form>
          )}
        </section>
      )}

      <form action={saveDeal.bind(null, deal.id)} className="stack-panels">
        <input type="hidden" name="vehicleId" value={deal.vehicleId} />
        <DealFields v={deal} currency={currency()} locked={!write} />
        {write && <div className="actions"><button type="submit" className="btn btn-primary">Save changes</button></div>}
      </form>

      {write && (
        <section className="glass panel">
          <details className="return-form">
            <summary className="btn btn-glass btn-small">Cancel this deal</summary>
            <form action={cancel.bind(null, deal.id)} className="stack">
              <p className="muted">The car stays on the lot. Any money already taken is refunded by you; the deal records that it is due.</p>
              <label className="field"><span>Why</span><input name="reason" required maxLength={200} /></label>
              <div className="actions"><button type="submit" className="btn btn-glass">Cancel the deal</button></div>
            </form>
          </details>
        </section>
      )}
    </>
  );
}
