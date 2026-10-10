import Link from "next/link";
import { can, listCustomers } from "@bos/core";
import { SearchIcon } from "../../../components/icons";
import { requireSession } from "../../../lib/session";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { ctx } = await requireSession();
  const { q = "" } = await searchParams;
  if (!can(ctx, "customer.read")) {
    return (
      <section className="glass panel empty">
        <div className="empty-title">No access</div>
        <p>Your role does not include customer records. Ask an owner or admin if you need them.</p>
      </section>
    );
  }
  const customers = await listCustomers(ctx, { search: q });
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            {customers.length} {customers.length === 1 ? "account" : "accounts"}
          </div>
          <h1>Customers</h1>
        </div>
        <form className="glass search" role="search">
          <SearchIcon />
          <label className="sr-only" htmlFor="q">
            Search customers
          </label>
          <input id="q" name="q" type="search" placeholder="Search customers" defaultValue={q} />
        </form>
        {can(ctx, "customer.write") && (
          <Link href="/customers/new" className="btn btn-primary">
            New customer
          </Link>
        )}
      </header>
      <section className="glass panel">
        {customers.length === 0 ? (
          <div className="empty">
            <div className="empty-title">{q ? "No customers match that search" : "No customers yet"}</div>
            <p>{q ? "Try a shorter name." : "Add your first customer to get started."}</p>
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
                      <Link href={`/customers/${customer.id}`} className="row-link">
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
