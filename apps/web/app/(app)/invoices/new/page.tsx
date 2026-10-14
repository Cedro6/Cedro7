import Link from "next/link";
import { redirect } from "next/navigation";
import { PAYMENT_METHODS, can, getRegion, listCustomers } from "@bos/core";
import { PaymentChoice } from "../../../../components/PaymentChoice";
import { requireSession } from "../../../../lib/session";
import { saveInvoice } from "../actions";

export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; customer?: string }>;
}) {
  const { ctx } = await requireSession();
  const region = await getRegion(ctx);
  if (!can(ctx, "invoice.write")) redirect("/invoices");
  const { error, customer } = await searchParams;
  const customers = await listCustomers(ctx);
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Link href="/invoices">Invoices</Link>
          </div>
          <h1>New invoice</h1>
        </div>
      </header>
      <form action={saveInvoice} className="stack">
        {error && <p className="error">{error}</p>}
        <section className="glass panel">
          <div className="form-row">
            <label className="field grow">
              <span>Customer</span>
              <select name="customerId" required defaultValue={customer ?? ""}>
                <option value="">Choose a customer</option>
                {customers.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                    {option.paymentTerms ? ` · ${option.paymentTerms}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field tax-field">
              <span>Tax %</span>
              <input name="taxRatePercent" type="number" min="0" max="99" step="any" inputMode="decimal" placeholder={`Usual (${region.defaultTaxPercent}%)`} title="Leave blank for your usual rate, or no tax for a customer marked as not charged tax" />
            </label>
          </div>
          <PaymentChoice methods={PAYMENT_METHODS} />
        </section>
        <section className="glass panel">
          <h2 className="title">Lines</h2>
          <div className="stack">
            {[1, 2, 3, 4, 5].map((n) => (
              <div className="order-line" key={n}>
                <label className="field order-line-product">
                  <span>{n === 1 ? "What it is for" : <span className="sr-only">Description {n}</span>}</span>
                  <input name="description" maxLength={300} required={n === 1} placeholder={n === 1 ? "Delivery and setup" : ""} />
                </label>
                <label className="field order-line-qty">
                  <span>{n === 1 ? "Quantity" : <span className="sr-only">Quantity {n}</span>}</span>
                  <input name="qty" type="number" min="0.0001" step="any" required={n === 1} inputMode="decimal" />
                </label>
                <label className="field order-line-qty">
                  <span>{n === 1 ? "Price each" : <span className="sr-only">Price {n}</span>}</span>
                  <input name="unitPrice" type="number" min="0" step="any" required={n === 1} inputMode="decimal" />
                </label>
              </div>
            ))}
          </div>
          <p className="muted footnote">Leave a row empty if you do not need it.</p>
        </section>
        <section className="glass panel">
          <label className="field">
            <span>Note on the invoice (optional)</span>
            <input name="notes" maxLength={2000} />
          </label>
        </section>
        <div className="actions">
          <button type="submit" className="btn btn-primary">
            Save invoice
          </button>
          <Link href="/invoices" className="btn btn-glass">
            Cancel
          </Link>
        </div>
        <p className="muted footnote">
          Use this for work that is not on an order. Orders raise their own invoices when they ship or are completed. Left empty, the due
          date follows the customer&apos;s payment terms.
        </p>
      </form>
    </>
  );
}
