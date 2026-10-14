import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { can, cashReport, DEAL_PAYMENT_METHODS, featureOn, FILE_KIND_TEXT, getDeal, listDealerFiles, listTeam, seesCost } from "@bos/core";
import { FileUpload } from "../../../../components/FileUpload";
import { DealForm } from "../../../../components/DealForm";
import { currency, todayHere, whole, zone } from "../../../../lib/locale";
import { formatMoney } from "../../../../lib/format";
import { requireSession } from "../../../../lib/session";
import { cancel, deleteFile, deliver, saveDeal, saveFollowUp, takePayment } from "../actions";
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
  const edit = can(ctx, "vehicle.write") && deal.status !== "cancelled";
  const [files, team] = await Promise.all([listDealerFiles(ctx, { dealId: deal.id }), listTeam(ctx)]);
  const cash = cashReport(deal.payments);
  const follow = saveFollowUp.bind(null, deal.id);
  const kb = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);
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

      {deal.status !== "open" && (
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
      )}

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
              <Link href={`/deals/${deal.id}/buyers-guide`} className="btn btn-glass btn-small">Open</Link>
            </li>
            {Object.entries(FLORIDA_FORMS).map(([key, f]) => (
              <li key={key}>
                <div><strong>{f.title}</strong><div className="muted">{f.about}</div></div>
                <Link href={`/deals/${deal.id}/documents/${key}`} className="btn btn-glass btn-small">Fill and open</Link>
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
                <thead><tr><th>Date</th><th>How</th><th>Reference</th><th className="num">Amount</th><th>By</th><th><span className="sr-only">Receipt</span></th></tr></thead>
                <tbody>{deal.payments.map((p) => <tr key={p.id}><td>{p.paidOn}</td><td>{p.method}</td><td>{p.reference ?? "—"}</td><td className="num">{formatMoney(p.amount)}</td><td>{p.recordedBy ?? "—"}</td><td><Link href={`/deals/${deal.id}/receipt/${p.id}`} className="row-link">Receipt</Link></td></tr>)}</tbody>
              </table>
            </div>
          )}
          {write && !paid && (
            <form action={takePayment.bind(null, deal.id)} className="form-row deal-pay">
              <label className="field"><span>Amount</span><input name="amount" inputMode="decimal" required defaultValue={deal.balance.toFixed(2)} /></label>
              <label className="field"><span>How</span><select name="method" defaultValue="Cash">{DEAL_PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}</select></label>
              <label className="field"><span>Reference</span><input name="reference" maxLength={100} placeholder="Check no., last 4…" /></label>
              <label className="field"><span>Date</span><input name="paidOn" type="date" required defaultValue={todayHere()} /></label>
              <div className="field"><span>&nbsp;</span><button type="submit" className="btn btn-primary">Record payment</button></div>
            </form>
          )}
        </section>
      )}

      {cash.required && (
        <section className="glass panel" id="form-8300">
          <div className="panel-head">
            <div>
              <h2 className="title">Cash over $10,000: IRS Form 8300</h2>
              <p className="muted">
                {formatMoney(cash.total)} came in as cash, or as cashier&apos;s checks and money orders of $10,000 or less, which count as cash on a car sale.
                The dealership must file Form 8300 with the IRS within 15 days of passing $10,000{cash.dueOn ? `, so by ${cash.dueOn}` : ""}, and send the buyer a written notice by January 31 of next year.
              </p>
            </div>
            {deal.form8300FiledOn ? <span className="badge badge-ok">Filed {deal.form8300FiledOn}</span> : <span className="badge badge-bad">Not filed yet</span>}
          </div>
          <div className="actions">
            <Link href={`/deals/${deal.id}/form-8300`} className="btn btn-glass">Open the 8300 worksheet</Link>
          </div>
          {edit && (
            <form action={follow} className="form-row">
              <input type="hidden" name="section" value="form-8300" />
              <label className="field"><span>Buyer&apos;s occupation</span><input name="buyerOccupation" maxLength={80} defaultValue={deal.buyerOccupation ?? ""} placeholder="Asked on the form" /></label>
              <label className="field"><span>Filed with the IRS on</span><input name="form8300FiledOn" type="date" defaultValue={deal.form8300FiledOn ?? ""} /></label>
              <div className="field"><span>&nbsp;</span><button type="submit" className="btn btn-primary">Save</button></div>
            </form>
          )}
          <p className="muted footnote">The site does not file anything. File through the IRS (BSA E-Filing) or on paper, then record the date here. Check the rules with your accountant.</p>
        </section>
      )}

      {deal.status !== "cancelled" && (
        <section className="glass panel" id="after-sale">
          <div className="panel-head">
            <div>
              <h2 className="title">After the sale</h2>
              <p className="muted">Who sold it, the temporary tag, and the title application at the tag office. Florida gives the dealer 30 days from the sale to apply for the buyer&apos;s title. A temp tag with no expiry date runs 30 days from issue.</p>
            </div>
            {deal.titleDoneOn ? <span className="badge badge-ok">Title done {deal.titleDoneOn}</span> : deal.titleSentOn ? <span className="badge">Title sent {deal.titleSentOn}</span> : deal.status === "delivered" && deal.deliveredOn ? <span className="badge badge-warn">Title due by {new Date(Date.parse(`${deal.deliveredOn}T12:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10)}</span> : null}
          </div>
          <form action={follow} className="stack">
            <input type="hidden" name="section" value="after-sale" />
            <fieldset disabled={!edit} className="veh-fieldset">
              <div className="form-row">
                <label className="field"><span>Salesperson</span>
                  <select name="salespersonId" defaultValue={deal.salespersonId ?? ""}>
                    <option value="">Not recorded</option>
                    {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
                {seesCost(ctx) && <label className="field"><span>Commission</span><input name="commission" inputMode="decimal" defaultValue={deal.commission ?? ""} placeholder="0.00" /></label>}
              </div>
              <div className="form-row">
                <label className="field"><span>Temp tag number</span><input name="tempTagNumber" maxLength={20} defaultValue={deal.tempTagNumber ?? ""} /></label>
                <label className="field"><span>Issued on</span><input name="tempTagIssuedOn" type="date" defaultValue={deal.tempTagIssuedOn ?? ""} /></label>
                <label className="field"><span>Expires on</span><input name="tempTagExpiresOn" type="date" defaultValue={deal.tempTagExpiresOn ?? ""} /></label>
              </div>
              <div className="form-row">
                <label className="field"><span>Title application sent</span><input name="titleSentOn" type="date" defaultValue={deal.titleSentOn ?? ""} /></label>
                <label className="field"><span>Plate number</span><input name="plateNumber" maxLength={20} defaultValue={deal.plateNumber ?? ""} /></label>
                <label className="field"><span>Title and plate done</span><input name="titleDoneOn" type="date" defaultValue={deal.titleDoneOn ?? ""} /></label>
              </div>
            </fieldset>
            {edit && <div className="actions"><button type="submit" className="btn btn-primary">Save</button></div>}
          </form>
        </section>
      )}

      <section className="glass panel" id="documents">
        <div className="panel-head">
          <div>
            <h2 className="title">Signed paperwork and documents</h2>
            <p className="muted">Keep the signed forms, the buyer&apos;s licence and the title with the deal. Photos from a phone are shrunk before upload; PDFs up to 4.4 MB.</p>
          </div>
          <span className="muted">{files.length} {files.length === 1 ? "file" : "files"}</span>
        </div>
        {files.length > 0 && (
          <div className="table-wrap">
            <table className="compact">
              <thead><tr><th>File</th><th>What it is</th><th className="num">Size</th><th>Added</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id}>
                    <td><a href={`/files/${f.id}`} className="row-link" target="_blank" rel="noreferrer">{f.name}</a></td>
                    <td>{FILE_KIND_TEXT[f.kind]}</td>
                    <td className="num">{kb(f.sizeBytes)}</td>
                    <td>{new Intl.DateTimeFormat("en-CA", { timeZone: zone() }).format(f.createdAt)}{f.by ? ` · ${f.by}` : ""}</td>
                    <td className="row-actions">
                      <a href={`/files/${f.id}?download=1`} className="btn btn-glass btn-small">Download</a>
                      {can(ctx, "vehicle.write") && <form action={deleteFile.bind(null, f.id)}><button type="submit" className="btn btn-glass btn-small">Remove</button></form>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {can(ctx, "vehicle.write") && (
          <FileUpload
            dealId={deal.id} accept="image/*,application/pdf" label="Photo or PDF"
            kinds={(["signed_form", "licence", "title", "receipt", "other"] as const).map((k) => ({ value: k, label: FILE_KIND_TEXT[k] }))}
          />
        )}
      </section>

      <DealForm
        action={saveDeal.bind(null, deal.id)} submitLabel="Save changes" locked={!write} currency={currency()} paid={deal.paid}
        chosen={{ id: deal.vehicleId, stockNumber: deal.stockNumber, name: deal.vehicleName, vin: deal.vin, askingPrice: null, mileage: deal.odometer, status: "on_lot" }}
        v={deal}
      />

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
