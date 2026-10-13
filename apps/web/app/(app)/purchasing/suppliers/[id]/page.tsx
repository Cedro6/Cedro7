import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { can, getSupplier } from "@bos/core";
import { requireSession } from "../../../../../lib/session";
import { archiveSupplier, editSupplier } from "../../../records-actions";

export default async function EditSupplierPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { ctx } = await requireSession();
  const { id } = await params;
  if (!can(ctx, "purchase_order.write")) redirect("/purchasing");
  const supplier = await getSupplier(ctx, id);
  if (!supplier) notFound();
  const { error } = await searchParams;
  const archived = supplier.status === "archived";
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Link href="/purchasing">Purchasing</Link>
          </div>
          <h1>Edit supplier</h1>
        </div>
        {archived && <span className="badge badge-warn badge-large">Archived</span>}
      </header>
      {error && <p className="error">{error}</p>}
      <section className="glass panel form-panel">
        <form action={editSupplier} className="stack">
          <input type="hidden" name="id" value={id} />
          <label className="field">
            <span>Supplier name</span>
            <input name="name" required maxLength={200} defaultValue={supplier.name} />
          </label>
          <label className="field">
            <span>Email</span>
            <input name="email" type="email" maxLength={200} defaultValue={supplier.email ?? ""} />
          </label>
          <label className="field">
            <span>Phone</span>
            <input name="phone" maxLength={50} defaultValue={supplier.phone ?? ""} />
          </label>
          <label className="field">
            <span>Payment terms</span>
            <input name="paymentTerms" maxLength={50} placeholder="Net 30" defaultValue={supplier.paymentTerms ?? ""} />
          </label>
          <label className="field">
            <span>Address (printed on purchase orders)</span>
            <textarea name="address" rows={3} maxLength={500} defaultValue={supplier.address ?? ""} />
          </label>
          <label className="field">
            <span>Lead time in days</span>
            <input name="leadTimeDays" type="number" min="0" max="730" step="1" inputMode="numeric" defaultValue={supplier.leadTimeDays ?? ""} />
          </label>
          <div className="actions">
            <button type="submit" className="btn btn-primary">Save</button>
            <Link href="/purchasing" className="btn btn-glass">Cancel</Link>
          </div>
        </form>
      </section>
      <section className="glass panel form-panel">
        <h2 className="title">{archived ? "Restore this supplier" : "Archive this supplier"}</h2>
        <p className="muted">
          {archived
            ? "Restoring lets you raise purchase orders with this supplier again."
            : "Archiving hides the supplier from new purchase orders. Past orders are kept, and you can restore them any time."}
        </p>
        <form action={archiveSupplier} className="actions">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="archived" value={archived ? "0" : "1"} />
          <button type="submit" className={`btn btn-glass ${archived ? "" : "btn-danger"}`}>{archived ? "Restore supplier" : "Archive supplier"}</button>
        </form>
      </section>
    </>
  );
}
