import Link from "next/link";
import { can, listArchivedCustomers, listCustomers } from "@bos/core";
import { SearchIcon } from "../../../components/icons";
import { requireSession } from "../../../lib/session";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; archived?: string; notice?: string }> }) {
  const { ctx } = await requireSession();
  const { q = "", archived, notice } = await searchParams;
  const showArchived = archived === "1";
  if (!can(ctx, "customer.read")) {
    return (
      <section className="glass panel empty">
        <div className="empty-title">No access</div>
        <p>Your role does not include customer records. Ask an owner or admin if you need them.</p>
      </section>
    );
  }
  const customers = showArchived ? await listArchivedCustomers(ctx) : await listCustomers(ctx, { search: q });
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            {customers.length} {customers.length === 1 ? "account" : "accounts"}{showArchived ? " archived" : ""}
          </div>
          <h1>Customers</h1>
        </div>
        <div className="segmented" role="group" aria-label="Filter">
          <Link href="/customers" aria-current={showArchived ? undefined : "true"}>
            Active
          </Link>
          <Link href="/customers?archived=1" aria-current={showArchived ? "true" : undefined}>
            Archived
          </Link>
        </div>
        <form className="glass search" role="search">
          <SearchIcon />
          <label className="sr-only" htmlFor="q">
            Search customers
          </label>
          <input id="q" name="q" type="search" placeholder="Search customers" defaultValue={q} />
        </form>
        {can(ctx, "customer.write") && (
          <>
            <Link href="/import?kind=customers" className="btn btn-glass">Import</Link>
          <Link href="/customers/new" className="btn btn-primary">
            New customer
          </Link>
          </>
        )}
      </header>
      {notice && <p className="notice">{notice}</p>}
      <section className="glass panel">
        {customers.length === 0 ? (
          <div className="empty">
            <div className="empty-title">{showArchived ? "Nothing archived" : q ? "No customers match that search" : "No customers yet"}</div>
            <p>{showArchived ? "Customers you archive are kept here." : q ? "Try a shorter name." : "Add your first customer to get started."}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Main contact</th>
                  <th>Account owner</th>
                  <th>Terms</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id}>
                    <td>
                      <Link href={showArchived ? `/customers/${customer.id}/edit` : `/customers/${customer.id}`} className="row-link">
                        {customer.name}
                      </Link>
                    </td>
                    <td>{customer.primaryContact ?? <span className="muted">None</span>}</td>
                    <td>{customer.ownerName ?? <span className="muted">Unassigned</span>}</td>
                    <td>{customer.paymentTerms ?? <span className="muted">Not set</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
