import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@bos/core";
import { requireSession } from "../../../../../lib/session";
import { saveSupplier } from "../../actions";

export default async function NewSupplierPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "purchase_order.write")) redirect("/purchasing");
  const { error } = await searchParams;
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Link href="/purchasing">Purchasing</Link>
          </div>
          <h1>New supplier</h1>
        </div>
      </header>
      <section className="glass panel form-panel">
        <form action={saveSupplier} className="stack">
          {error && <p className="error">{error}</p>}
          <label className="field">
            <span>Supplier name</span>
            <input name="name" required maxLength={200} autoFocus />
          </label>
          <label className="field">
            <span>Email</span>
            <input name="email" type="email" maxLength={200} />
          </label>
          <label className="field">
            <span>Phone</span>
            <input name="phone" maxLength={50} />
          </label>
          <label className="field">
            <span>Payment terms</span>
            <input name="paymentTerms" maxLength={50} placeholder="Net 30" />
          </label>
          <label className="field">
            <span>Lead time in days</span>
            <input name="leadTimeDays" type="number" min="0" max="730" step="1" inputMode="numeric" />
          </label>
          <div className="actions">
            <button type="submit" className="btn btn-primary">
              Save supplier
            </button>
            <Link href="/purchasing" className="btn btn-glass">
              Cancel
            </Link>
          </div>
        </form>
      </section>
    </>
  );
}
