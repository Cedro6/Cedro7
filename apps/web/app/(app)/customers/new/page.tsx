import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@bos/core";
import { requireSession } from "../../../../lib/session";
import { saveCustomer } from "./actions";

export default async function NewCustomerPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "customer.write")) redirect("/customers");
  const { error } = await searchParams;
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Link href="/customers">Customers</Link>
          </div>
          <h1>New customer</h1>
        </div>
      </header>
      <section className="glass panel form-panel">
        <form action={saveCustomer} className="stack">
          {error && <p className="error">{error}</p>}
          <label className="field">
            <span>Company name</span>
            <input name="name" required maxLength={200} autoFocus />
          </label>
          <label className="field">
            <span>Payment terms</span>
            <input name="paymentTerms" maxLength={50} placeholder="Net 30" />
          </label>
          <div className="actions">
            <button type="submit" className="btn btn-primary">
              Save customer
            </button>
            <Link href="/customers" className="btn btn-glass">
              Cancel
            </Link>
          </div>
        </form>
      </section>
    </>
  );
}
