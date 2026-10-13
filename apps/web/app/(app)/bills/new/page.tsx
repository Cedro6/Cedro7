import Link from "next/link";
import { redirect } from "next/navigation";
import { can, EXPENSE_CATEGORIES, listSuppliers, today } from "@bos/core";
import { requireSession } from "../../../../lib/session";
import { saveBill } from "../actions";

export default async function NewBillPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "expense.write")) redirect("/bills");
  const { error } = await searchParams;
  const suppliers = can(ctx, "purchase_order.read") ? await listSuppliers(ctx) : [];
  const on = today();
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow"><Link href="/bills">Bills and expenses</Link></div>
          <h1>New bill or expense</h1>
        </div>
      </header>
      <section className="glass panel form-panel">
        <form action={saveBill} className="stack">
          {error && <p className="error">{error}</p>}
          <label className="field">
            <span>What was it for?</span>
            <input name="description" required maxLength={200} autoFocus placeholder="October rent" />
          </label>
          <div className="form-row">
            <label className="field grow">
              <span>Category</span>
              <select name="category" required defaultValue="">
                <option value="" disabled>Choose one</option>
                {EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label className="field grow">
              <span>Amount</span>
              <input name="amount" required inputMode="decimal" placeholder="0.00" />
            </label>
          </div>
          <p className="muted">Use Stock purchases for goods you will resell. They count as money out, but are not taken off profit a second time.</p>
          <div className="form-row">
            <label className="field grow">
              <span>Date of the bill or purchase</span>
              <input name="incurredOn" type="date" required defaultValue={on} />
            </label>
            {suppliers.length > 0 && (
              <label className="field grow">
                <span>Supplier (optional)</span>
                <select name="supplierId" defaultValue="">
                  <option value="">None</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            )}
            <label className="field grow">
              <span>Their invoice number (optional)</span>
              <input name="reference" maxLength={60} />
            </label>
          </div>
          <fieldset className="bill-paid">
            <legend>Has it been paid?</legend>
            <label className="bill-choice">
              <input type="radio" name="paid" value="0" defaultChecked /> <span>Not yet. It is a bill to pay.</span>
            </label>
            <label className="field bill-when bill-when-due">
              <span>Due date (optional)</span>
              <input name="dueOn" type="date" />
            </label>
            <label className="bill-choice">
              <input type="radio" name="paid" value="1" /> <span>Yes, already paid.</span>
            </label>
            <div className="form-row bill-when bill-when-paid">
              <label className="field grow">
                <span>Paid on (blank means the date above)</span>
                <input name="paidOn" type="date" />
              </label>
              <label className="field grow">
                <span>Paid by (optional)</span>
                <input name="paidMethod" maxLength={40} placeholder="Card, check, bank transfer" />
              </label>
            </div>
          </fieldset>
          <div className="actions">
            <button type="submit" className="btn btn-primary">Save</button>
            <Link href="/bills" className="btn btn-glass">Cancel</Link>
          </div>
        </form>
      </section>
    </>
  );
}
