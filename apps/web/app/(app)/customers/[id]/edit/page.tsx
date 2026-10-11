import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { can, customerStatus, getCustomer } from "@bos/core";
import { requireSession } from "../../../../../lib/session";
import { archiveCustomer, deleteContact, editContact, editCustomer } from "../../../records-actions";

export default async function EditCustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { ctx } = await requireSession();
  const { id } = await params;
  if (!can(ctx, "customer.write")) redirect(`/customers/${id}`);
  const [customer, status] = await Promise.all([getCustomer(ctx, id), customerStatus(ctx, id)]);
  if (!customer) notFound();
  const { error, notice } = await searchParams;
  const archived = status === "archived";
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Link href="/customers">Customers</Link> · <Link href={`/customers/${id}`}>{customer.name}</Link>
          </div>
          <h1>Edit customer</h1>
        </div>
        {archived && <span className="badge badge-warn badge-large">Archived</span>}
      </header>
      {error && <p className="error">{error}</p>}
      {notice && !error && <p className="notice">{notice}</p>}
      <section className="glass panel form-panel">
        <h2 className="title">Details</h2>
        <form action={editCustomer} className="stack">
          <input type="hidden" name="id" value={id} />
          <label className="field">
            <span>Company name</span>
            <input name="name" required maxLength={200} defaultValue={customer.name} />
          </label>
          <label className="field">
            <span>Payment terms</span>
            <input name="paymentTerms" maxLength={50} placeholder="Net 30" defaultValue={customer.paymentTerms ?? ""} />
          </label>
          <div className="actions">
            <button type="submit" className="btn btn-primary">Save</button>
            <Link href={`/customers/${id}`} className="btn btn-glass">Cancel</Link>
          </div>
        </form>
      </section>
      <section className="glass panel form-panel">
        <h2 className="title">Contacts</h2>
        <div className="stack">
          {customer.contacts.map((contact) => (
            <details key={contact.id} className="edit-item">
              <summary>
                <span className="row-title">{contact.name}</span>
                <span className="muted">{[contact.title, contact.isPrimary ? "Main contact" : null].filter(Boolean).join(" · ")}</span>
              </summary>
              <form action={editContact} className="stack">
                <input type="hidden" name="customerId" value={id} />
                <input type="hidden" name="contactId" value={contact.id} />
                <ContactFields contact={contact} />
                <div className="actions">
                  <button type="submit" className="btn btn-glass btn-small">Save contact</button>
                  <button type="submit" formAction={deleteContact} formNoValidate className="btn btn-glass btn-small btn-danger">Remove</button>
                </div>
              </form>
            </details>
          ))}
          <details className="edit-item" open={customer.contacts.length === 0}>
            <summary><span className="row-title">Add a contact</span></summary>
            <form action={editContact} className="stack">
              <input type="hidden" name="customerId" value={id} />
              <ContactFields />
              <div className="actions">
                <button type="submit" className="btn btn-glass btn-small">Add contact</button>
              </div>
            </form>
          </details>
        </div>
      </section>
      <section className="glass panel form-panel">
        <h2 className="title">{archived ? "Restore this customer" : "Archive this customer"}</h2>
        <p className="muted">
          {archived
            ? "Restoring puts the customer back in your lists and lets you take new orders."
            : "Archiving hides the customer from lists and new orders. Their orders and invoices are kept, and you can restore them any time."}
        </p>
        <form action={archiveCustomer} className="actions">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="archived" value={archived ? "0" : "1"} />
          <button type="submit" className={`btn btn-glass ${archived ? "" : "btn-danger"}`}>{archived ? "Restore customer" : "Archive customer"}</button>
        </form>
      </section>
    </>
  );
}

function ContactFields({ contact }: { contact?: { name: string; title: string | null; email: string | null; phone: string | null; isPrimary: boolean } }) {
  return (
    <>
      <label className="field">
        <span>Name</span>
        <input name="name" required maxLength={200} defaultValue={contact?.name ?? ""} />
      </label>
      <label className="field">
        <span>Job title</span>
        <input name="title" maxLength={100} defaultValue={contact?.title ?? ""} />
      </label>
      <label className="field">
        <span>Email</span>
        <input name="email" type="email" maxLength={200} defaultValue={contact?.email ?? ""} />
      </label>
      <label className="field">
        <span>Phone</span>
        <input name="phone" maxLength={50} defaultValue={contact?.phone ?? ""} />
      </label>
      <label className="check">
        <input type="checkbox" name="isPrimary" defaultChecked={contact?.isPrimary ?? false} /> Main contact
      </label>
    </>
  );
}
