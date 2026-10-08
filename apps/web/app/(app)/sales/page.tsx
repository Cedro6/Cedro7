import Link from "next/link";
import { can, listOrders, type OrderStatus } from "@bos/core";
import { StatusBadge } from "../../../components/StatusBadge";
import { formatMoney, formatQty } from "../../../lib/format";
import { requireSession } from "../../../lib/session";

const filters: { key: string; label: string; status?: OrderStatus | "open" }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open", status: "open" },
  { key: "quote", label: "Quotes", status: "quote" },
  { key: "shipped", label: "Shipped", status: "shipped" },
];

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

export default async function SalesPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { ctx } = await requireSession();
  const { show = "all" } = await searchParams;
  const active = filters.find((filter) => filter.key === show) ?? filters[0]!;
  const orders = await listOrders(ctx, { status: active.status });
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            {orders.length} {orders.length === 1 ? "order" : "orders"}
          </div>
          <h1>Sales</h1>
        </div>
        <div className="segmented" role="group" aria-label="Filter">
          {filters.map((filter) => (
            <Link
              key={filter.key}
              href={filter.key === "all" ? "/sales" : `/sales?show=${filter.key}`}
              aria-current={filter.key === active.key ? "true" : undefined}
            >
              {filter.label}
            </Link>
          ))}
        </div>
        {can(ctx.role, "sales_order.write") && (
          <Link href="/sales/new" className="btn btn-primary">
            New order
          </Link>
        )}
      </header>
      <section className="glass panel">
        {orders.length === 0 ? (
          <div className="empty">
            <div className="empty-title">No orders here yet</div>
            <p>Orders appear in this list as soon as a quote is created.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Fulfilment</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const back = order.unitsOrdered - order.unitsShipped - order.unitsReserved;
                  const open = order.status === "confirmed" || order.status === "partially_shipped";
                  return (
                    <tr key={order.id}>
                      <td>
                        <Link href={`/sales/${order.id}`} className="row-link mono">
                          {order.number}
                        </Link>
                        <div className="muted">{day.format(order.createdAt)}</div>
                      </td>
                      <td>{order.customerName}</td>
                      <td>
                        <StatusBadge status={order.status} />
                      </td>
                      <td>
                        <div
                          className="meter"
                          role="img"
                          aria-label={`${order.unitsShipped} shipped, ${order.unitsReserved} ready, ${back} not reserved`}
                        >
                          {order.unitsShipped > 0 && <span className="meter-shipped" style={{ flexGrow: order.unitsShipped }} />}
                          {order.unitsReserved > 0 && <span className="meter-ready" style={{ flexGrow: order.unitsReserved }} />}
                          {back > 0 && <span className={open ? "meter-back" : "meter-idle"} style={{ flexGrow: back }} />}
                        </div>
                        <div className="muted">
                          {formatQty(order.unitsShipped)} of {formatQty(order.unitsOrdered)} shipped
                          {order.unitsReserved > 0 ? ` · ${formatQty(order.unitsReserved)} ready` : ""}
                        </div>
                      </td>
                      <td className="num strong">{formatMoney(order.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
