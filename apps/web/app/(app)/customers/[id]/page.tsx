import Link from "next/link";
import { notFound } from "next/navigation";
import { can, featureOn, getCustomer, listOrders, listPriceLists } from "@bos/core";
import { StatusBadge } from "../../../../components/StatusBadge";
import { Avatar } from "../../../../components/Avatar";
import { formatMoney } from "../../../../lib/format";
import { requireSession } from "../../../../lib/session";
import { assignPriceList } from "../../sales/actions";

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { ctx } = await requireSession();
  const { id } = await params;
  if (!can(ctx, "customer.read")) notFound();
  const customer = await getCustomer(ctx, id);
  if (!customer) notFound();
  const { error, notice } = await searchParams;
  const orders = can(ctx, "sales_order.read") ? await listOrders(ctx, { customerId: id }) : [];
  const priceLists = can(ctx, "sales_order.read") ? await listPriceLists(ctx) : [];
  const tracked = featureOn(ctx.features, "stock");
  const since = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
    customer.createdAt,
  );
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Link href="/customers">Customers</Link>
          </div>
          <h1>{customer.name}</h1>
        </div>
        {can(ctx, "sales_order.write") && (
          <Link href={`/sales/new?customer=${customer.id}`} className="btn btn-primary">
            New order
          </Link>
        )}
      </header>
      {error && <p className="error">{error}</p>}
      {notice && !error && <p className="notice">{notice}</p>}
      <div className="tiles">
        <div className="glass panel tile">
          <h2 className="label">Payment terms</h2>
          <div className="numeral numeral-md">{customer.paymentTerms ?? "Not set"}</div>
        </div>
        <div className="glass panel tile">
          <h2 className="label">Account owner</h2>
          <div className="numeral numeral-md">{customer.ownerName ?? "Unassigned"}</div>
        </div>
        <div className="glass panel tile">
          <h2 className="label">Customer since</h2>
          <div className="numeral numeral-md">{since}</div>
        </div>
      </div>
      {priceLists.length > 0 && (
        <section className="glass panel">
          <div className="panel-head">
            <div>
              <h2 className="title">Price list</h2>
              <div className="muted">
                {customer.priceListName
                  ? `New orders for this customer use the "${customer.priceListName}" prices.`
                  : "This customer pays list prices."}
              </div>
            </div>
            {can(ctx, "customer.write") && (
              <form action={assignPriceList} className="inline-form">
                <input type="hidden" name="customerId" value={customer.id} />
                <label className="sr-only" htmlFor="price-list">
                  Price list
                </label>
                <select id="price-list" name="priceListId" className="select-pill glass" defaultValue={customer.priceListId ?? ""}>
                  <option value="">List prices</option>
                  {priceLists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name}
                    </option>
                  ))}
                </select>
                <button type="submit" className="btn btn-glass btn-small">
                  Save
                </button>
              </form>
            )}
          </div>
        </section>
      )}
      <section className="glass panel">
        <h2 className="title">Contacts</h2>
        {customer.contacts.length === 0 ? (
          <p className="muted">No contacts yet.</p>
        ) : (
          <div className="rows">
            {customer.contacts.map((contact) => (
              <div className="row" key={contact.id}>
                <Avatar name={contact.name} />
                <div className="row-text">
                  <div className="row-title">{contact.name}</div>
                  <div className="muted">{contact.title ?? "No title"}</div>
                </div>
                <div className="muted contact-lines">
                  {contact.email && <a href={`mailto:${contact.email}`}>{contact.email}</a>}
                  {contact.phone && <span>{contact.phone}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="glass panel">
        <h2 className="title">Orders</h2>
        {orders.length === 0 ? (
          <p className="muted">No orders yet.</p>
        ) : (
          <div className="rows">
            {orders.map((order) => (
              <div className="row" key={order.id}>
                <div className="row-text">
                  <Link href={`/sales/${order.id}`} className="row-link mono">
                    {order.number}
                  </Link>
                  <div className="muted">
                    {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(order.createdAt)}
                  </div>
                </div>
                <StatusBadge status={order.status} tracked={tracked} />
                <div className="strong order-total-cell">{formatMoney(order.total)}</div>
              </div>
            ))}
          </div>
        )}
      </section>
      <p className="muted footnote">Notes and reminders arrive in stage 6.</p>
    </>
  );
}
