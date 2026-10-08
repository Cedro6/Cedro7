import Link from "next/link";
import { can, listPurchaseOrders, listSuppliers, type PurchaseOrderStatus } from "@bos/core";
import { PoStatusBadge } from "../../../components/PoStatusBadge";
import { formatMoney, formatQty } from "../../../lib/format";
import { requireSession } from "../../../lib/session";

const filters: { key: string; label: string; status?: PurchaseOrderStatus | "open" }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open", status: "open" },
  { key: "draft", label: "Drafts", status: "draft" },
  { key: "received", label: "Received", status: "received" },
];

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export default async function PurchasingPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx.role, "purchase_order.read")) {
    return (
      <section className="glass panel empty">
        <div className="empty-title">No access</div>
        <p>Your role does not include purchasing. Ask an owner or admin if you need it.</p>
      </section>
    );
  }
  const { show = "all" } = await searchParams;
  const active = filters.find((filter) => filter.key === show) ?? filters[0]!;
  const [orders, suppliers] = await Promise.all([listPurchaseOrders(ctx, { status: active.status }), listSuppliers(ctx)]);
  const canWrite = can(ctx.role, "purchase_order.write");
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            {orders.length} purchase {orders.length === 1 ? "order" : "orders"}
          </div>
          <h1>Purchasing</h1>
        </div>
        <div className="segmented" role="group" aria-label="Filter">
          {filters.map((filter) => (
            <Link
              key={filter.key}
              href={filter.key === "all" ? "/purchasing" : `/purchasing?show=${filter.key}`}
              aria-current={filter.key === active.key ? "true" : undefined}
            >
              {filter.label}
            </Link>
          ))}
        </div>
        {canWrite && (
          <>
            <Link href="/purchasing/new?low=1" className="btn btn-glass">
              Reorder low stock
            </Link>
            <Link href="/purchasing/new" className="btn btn-primary">
              New purchase order
            </Link>
          </>
        )}
      </header>
      <section className="glass panel">
        {orders.length === 0 ? (
          <div className="empty">
            <div className="empty-title">No purchase orders here yet</div>
            <p>Create one, or start from the products that are running low.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Supplier</th>
                  <th>Status</th>
                  <th>Received</th>
                  <th>Expected</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const outstanding = order.unitsOrdered - order.unitsReceived;
                  return (
                    <tr key={order.id}>
                      <td>
                        <Link href={`/purchasing/${order.id}`} className="row-link mono">
                          {order.number}
                        </Link>
                      </td>
                      <td>{order.supplierName}</td>
                      <td>
                        <PoStatusBadge status={order.status} />
                      </td>
                      <td>
                        <div className="meter" role="img" aria-label={`${order.unitsReceived} of ${order.unitsOrdered} received`}>
                          {order.unitsReceived > 0 && <span className="meter-shipped" style={{ flexGrow: order.unitsReceived }} />}
                          {outstanding > 0 && <span className="meter-idle" style={{ flexGrow: outstanding }} />}
                        </div>
                        <div className="muted">
                          {formatQty(order.unitsReceived)} of {formatQty(order.unitsOrdered)}
                        </div>
                      </td>
                      <td>{order.expectedOn ? day.format(new Date(order.expectedOn)) : <span className="muted">Not set</span>}</td>
                      <td className="num strong">{order.total === null ? "" : formatMoney(order.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="glass panel">
        <div className="panel-head">
          <h2 className="title">Suppliers</h2>
          {canWrite && (
            <Link href="/purchasing/suppliers/new" className="btn btn-glass btn-small">
              New supplier
            </Link>
          )}
        </div>
        <div className="rows">
          {suppliers.map((supplier) => (
            <div className="row" key={supplier.id}>
              <div className="row-text">
                <div className="row-title">{supplier.name}</div>
                <div className="muted">
                  {[supplier.paymentTerms, supplier.leadTimeDays === null ? null : `${supplier.leadTimeDays} day lead time`]
                    .filter(Boolean)
                    .join(" · ") || "No terms recorded"}
                </div>
              </div>
              <div className="muted contact-lines">
                {supplier.email && <a href={`mailto:${supplier.email}`}>{supplier.email}</a>}
                {supplier.phone && <span>{supplier.phone}</span>}
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
