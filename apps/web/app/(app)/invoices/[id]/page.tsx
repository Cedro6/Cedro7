import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getInvoice, PAYMENT_METHODS, getCompanyProfile } from "@bos/core";
import { InvoiceBadge } from "../../../../components/InvoiceBadge";
import { PaperBrand } from "../../../../components/PaperBrand";
import { PrintButton } from "../../../../components/PrintButton";
import { formatMoney, formatQty } from "../../../../lib/format";
import { requireSession } from "../../../../lib/session";
import { credit, pay, useCredit, voidIt } from "../actions";

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const when = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});

export default async function InvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { ctx } = await requireSession();
  if (!can(ctx, "sales_order.read")) notFound();
  const { id } = await params;
  const { error, notice } = await searchParams;
  const invoice = await getInvoice(ctx, id);
  if (!invoice) notFound();
  const company = await getCompanyProfile(ctx);
  const manage = can(ctx, "invoice.write");
  const owing = invoice.balance > 0;
  const voidable = manage && invoice.kind === "manual" && invoice.state !== "void" && invoice.paid === 0 && invoice.credited === 0;
  const events = [
    { at: invoice.issuedAt, title: "Invoice raised", sub: formatMoney(invoice.amount), tone: "" },
    ...invoice.payments.map((p) => ({
      at: p.paidAt,
      title: "Payment received",
      sub: `${formatMoney(p.amount)} · ${p.method}${p.reference ? ` · ${p.reference}` : ""}${p.recordedBy ? ` · ${p.recordedBy}` : ""}`,
      tone: "dot-ok",
    })),
    ...invoice.credits.map((c) => ({ at: c.appliedAt, title: `Credit note ${c.number}`, sub: `${formatMoney(c.amount)} · ${c.reason}`, tone: "dot-warn" })),
    ...(invoice.voidedAt ? [{ at: invoice.voidedAt, title: "Voided", sub: invoice.voidReason ?? "", tone: "dot-bad" }] : []),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return (
    <>
      <header className="page-head no-print">
        <div>
          <div className="eyebrow">
            <Link href="/invoices">Invoices</Link> / <Link href={`/customers/${invoice.customerId}`}>{invoice.customerName}</Link>
            {invoice.orderId && (
              <>
                {" "}
                / <Link href={`/sales/${invoice.orderId}`}>{invoice.orderNumber}</Link>
              </>
            )}
          </div>
          <div className="title-row">
            <h1 className="mono">{invoice.number}</h1>
            <InvoiceBadge state={invoice.state} large />
          </div>
        </div>
        <PrintButton />
      </header>

      {error && <p className="error no-print">{error}</p>}
      {notice && !error && <p className="notice no-print">{notice}</p>}

      <div className="split">
        <div className="grow-3 stack-panels">
          <section className="paper">
            <div className="paper-head">
              <PaperBrand company={company} />
              <div className="paper-title">
                {invoice.kind === "deposit" ? "Deposit invoice" : "Invoice"}
                <div className="paper-muted mono">{invoice.number}</div>
              </div>
            </div>
            <div className="paper-meta">
              <div>
                <div className="paper-label">Bill to</div>
                <div className="paper-strong">{invoice.customerName}</div>
                {invoice.billToAddress && <div className="address">{invoice.billToAddress}</div>}
              </div>
              {invoice.shipToAddress && invoice.kind !== "deposit" && (
                <div>
                  <div className="paper-label">Ship to</div>
                  <div className="address">{invoice.shipToAddress}</div>
                </div>
              )}
              <div>
                <div className="paper-label">Issued</div>
                <div>{day.format(invoice.issuedAt)}</div>
                <div className="paper-label">Due</div>
                <div>
                  {day.format(invoice.dueAt)}
                  {invoice.paymentTerms && invoice.kind !== "deposit" ? ` · ${invoice.paymentTerms}` : ""}
                </div>
              </div>
              {invoice.orderNumber && (
                <div>
                  <div className="paper-label">Order</div>
                  <div className="mono">{invoice.orderNumber}</div>
                </div>
              )}
            </div>
            <div className="table-wrap">
              <table className="paper-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Qty</th>
                    <th className="num">Price</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.lines.map((line, index) => (
                    <tr key={index}>
                      <td>
                        {line.description}
                        {line.sku && <div className="paper-muted mono">{line.sku}</div>}
                      </td>
                      <td className="num">{formatQty(line.qty)}</td>
                      <td className="num">
                        {formatMoney(line.unitPrice)}
                        {line.discountPercent > 0 && (
                          <div className="paper-muted">
                            {formatQty(line.discountPercent)}% off {formatMoney(line.listPrice)}
                          </div>
                        )}
                      </td>
                      <td className="num">{formatMoney(line.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="paper-totals">
              {invoice.kind !== "deposit" && (
                <>
                  <div>
                    <span>Subtotal</span>
                    <span>{formatMoney(invoice.subtotal)}</span>
                  </div>
                  <div>
                    <span>Tax {formatQty(Math.round(invoice.taxRate * 1e6) / 1e4)}%</span>
                    <span>{formatMoney(invoice.tax)}</span>
                  </div>
                </>
              )}
              {invoice.depositApplied > 0 && (
                <div>
                  <span>Less deposit already billed</span>
                  <span>−{formatMoney(invoice.depositApplied)}</span>
                </div>
              )}
              <div className="paper-total">
                <span>Invoice total</span>
                <span>{formatMoney(invoice.amount)}</span>
              </div>
              {invoice.paid > 0 && (
                <div>
                  <span>Paid</span>
                  <span>−{formatMoney(invoice.paid)}</span>
                </div>
              )}
              {invoice.credited > 0 && (
                <div>
                  <span>Credited</span>
                  <span>−{formatMoney(invoice.credited)}</span>
                </div>
              )}
              {invoice.paid + invoice.credited > 0 && invoice.state !== "void" && (
                <div className="paper-total">
                  <span>Balance due</span>
                  <span>{formatMoney(invoice.balance)}</span>
                </div>
              )}
            </div>
            {invoice.notes && <p className="paper-note">{invoice.notes}</p>}
            {company.invoiceFooter && <p className="paper-note paper-footer address">{company.invoiceFooter}</p>}
            {invoice.state === "void" ? (
              <div className="paper-stamp paper-stamp-void">Void</div>
            ) : invoice.state === "paid" ? (
              <div className="paper-stamp">Paid{invoice.paidAt ? ` ${day.format(invoice.paidAt)}` : ""}</div>
            ) : null}
          </section>
          <p className="muted footnote no-print">
            Print this page, or choose &quot;Save as PDF&quot; in the print dialog, to send it. Emailing it from here and paying it online are
            not built yet.
          </p>
        </div>

        <aside className="grow-2 stack-panels no-print">
          {manage && owing && (
            <section className="glass panel">
              <div className="panel-head">
                <h2 className="title">Record a payment</h2>
                <span className="muted">{formatMoney(invoice.balance)} owed</span>
              </div>
              <form action={pay} className="stack">
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <input type="hidden" name="requestId" value={randomUUID()} />
                <div className="form-row">
                  <label className="field grow">
                    <span>Amount received</span>
                    <input
                      name="amount"
                      type="number"
                      min="0.01"
                      max={invoice.balance}
                      step="0.01"
                      required
                      inputMode="decimal"
                      defaultValue={invoice.balance.toFixed(2)}
                    />
                  </label>
                  <label className="field grow">
                    <span>How</span>
                    <select name="method" defaultValue={PAYMENT_METHODS[0]}>
                      {PAYMENT_METHODS.map((method) => (
                        <option key={method}>{method}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="field">
                  <span>Reference (optional)</span>
                  <input name="reference" maxLength={80} placeholder="Check number, bank reference" />
                </label>
                <button type="submit" className="btn btn-primary">
                  Record payment
                </button>
                <p className="muted">Enter less than the balance to record a part payment.</p>
              </form>
            </section>
          )}
          {manage && owing && invoice.customerCredit > 0 && (
            <section className="glass panel callout">
              <div className="row-text">
                <div className="row-title">
                  {invoice.customerName} has {formatMoney(invoice.customerCredit)} in credit
                </div>
                <div className="muted">From earlier credit notes.</div>
              </div>
              <form action={useCredit}>
                <input type="hidden" name="invoiceId" value={invoice.id} />
                <button type="submit" className="btn btn-glass btn-small">
                  Use it here
                </button>
              </form>
            </section>
          )}
          {manage && invoice.state !== "void" && (
            <section className="glass panel">
              <details className="disclosure disclosure-flat">
                <summary>Raise a credit note</summary>
                <form action={credit} className="stack">
                  <input type="hidden" name="invoiceId" value={invoice.id} />
                  <label className="field">
                    <span>Amount to credit</span>
                    <input name="amount" type="number" min="0.01" step="0.01" required inputMode="decimal" />
                  </label>
                  <label className="field">
                    <span>Reason</span>
                    <input name="reason" required maxLength={200} placeholder="Damaged, overcharged, goodwill" />
                  </label>
                  <button type="submit" className="btn btn-glass btn-small">
                    Raise credit note
                  </button>
                  <p className="muted">It comes off this invoice first. Anything more stays on the customer&apos;s account for later.</p>
                </form>
              </details>
              {voidable && (
                <details className="disclosure disclosure-flat">
                  <summary>Void this invoice</summary>
                  <form action={voidIt} className="stack">
                    <input type="hidden" name="invoiceId" value={invoice.id} />
                    <label className="field">
                      <span>Why it is being voided</span>
                      <input name="reason" required maxLength={200} />
                    </label>
                    <button type="submit" className="btn btn-danger btn-small">
                      Void invoice
                    </button>
                    <p className="muted">A void invoice stays on record and can no longer be paid.</p>
                  </form>
                </details>
              )}
            </section>
          )}
          <section className="glass panel">
            <h2 className="title">Activity</h2>
            <div className="rows">
              {events.map((event, index) => (
                <div className="row" key={index}>
                  <span className={`dot ${event.tone}`} aria-hidden="true" />
                  <div className="row-text">
                    <div className="row-title">{event.title}</div>
                    <div className="muted">
                      {when.format(event.at)}
                      {event.sub ? ` · ${event.sub}` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
