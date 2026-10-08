import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getOrder } from "@bos/core";
import { StatusBadge } from "../../../../components/StatusBadge";
import { formatMoney, formatQty } from "../../../../lib/format";
import { requireSession } from "../../../../lib/session";
import { cancel, confirm, reserve, ship } from "../actions";

const when = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { ctx } = await requireSession();
  const { id } = await params;
  const { error, notice } = await searchParams;
  const order = await getOrder(ctx, id);
  if (!order) notFound();

  const canWrite = can(ctx.role, "sales_order.write");
  const canShip = can(ctx.role, "sales_order.ship");
  const open = order.status === "confirmed" || order.status === "partially_shipped";
  const couldReserve = order.lines.reduce((sum, line) => sum + Math.min(line.backorder, line.availableNow), 0);

  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Link href="/sales">Sales</Link> / <Link href={`/customers/${order.customerId}`}>{order.customerName}</Link>
          </div>
          <div className="title-row">
            <h1>{order.number}</h1>
            <StatusBadge status={order.status} large />
          </div>
        </div>
        {canWrite && (order.status === "quote" || order.status === "confirmed") && (
          <form action={cancel}>
            <input type="hidden" name="orderId" value={order.id} />
            <button type="submit" className="btn btn-glass">
              Cancel order
            </button>
          </form>
        )}
        {canWrite && open && couldReserve > 0 && (
          <form action={reserve}>
            <input type="hidden" name="orderId" value={order.id} />
            <button type="submit" className="btn btn-glass">
              Reserve {formatQty(couldReserve)} now available
            </button>
          </form>
        )}
        {canWrite && order.status === "quote" && (
          <form action={confirm}>
            <input type="hidden" name="orderId" value={order.id} />
            <button type="submit" className="btn btn-primary">
              Confirm order
            </button>
          </form>
        )}
        {canShip && open && order.unitsReserved > 0 && (
          <form action={ship}>
            <input type="hidden" name="orderId" value={order.id} />
            <input type="hidden" name="requestId" value={randomUUID()} />
            <button type="submit" className="btn btn-primary">
              Ship what&apos;s ready
            </button>
          </form>
        )}
      </header>

      {error && <p className="error">{error}</p>}
      {notice && !error && <p className="notice">{notice}</p>}

      <section className="glass panel">
        <div className="panel-head">
          <div>
            <span className="numeral">{formatQty(order.unitsShipped)}</span>
            <span className="numeral-caption"> of {formatQty(order.unitsOrdered)} units shipped</span>
          </div>
          <div className="legend">
            <span>
              <i className="dot dot-white" />
              {formatQty(order.unitsShipped)} shipped
            </span>
            <span>
              <i className="dot dot-info" />
              {formatQty(order.unitsReserved)} ready to ship
            </span>
            {open && (
              <span>
                <i className="dot dot-warn" />
                {formatQty(order.unitsBackordered)} on backorder
              </span>
            )}
          </div>
        </div>
        <div className="meter meter-large" role="img" aria-label="Fulfilment progress">
          {order.unitsShipped > 0 && <span className="meter-shipped" style={{ flexGrow: order.unitsShipped }} />}
          {order.unitsReserved > 0 && <span className="meter-ready" style={{ flexGrow: order.unitsReserved }} />}
          {order.unitsOrdered - order.unitsShipped - order.unitsReserved > 0 && (
            <span
              className={open ? "meter-back" : "meter-idle"}
              style={{ flexGrow: order.unitsOrdered - order.unitsShipped - order.unitsReserved }}
            />
          )}
        </div>
        <p className="muted meter-note">
          {order.status === "quote" && "This is a quote. Nothing is reserved until it is confirmed."}
          {order.status === "cancelled" && "This order was cancelled and holds no stock."}
          {order.status === "shipped" && "Everything on this order has shipped."}
          {open && order.unitsBackordered > 0 && "Backordered units are reserved when stock arrives and you choose Reserve."}
          {open && order.unitsBackordered === 0 && "All remaining units are reserved and ready to ship."}
        </p>
      </section>

      <div className="split">
        <section className="glass panel grow-3">
          <h2 className="title">Items</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Ordered</th>
                  <th className="num">Shipped</th>
                  <th>Status</th>
                  <th className="num">Price</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((line) => (
                  <tr key={line.id}>
                    <td>
                      <Link href={`/products/${line.productId}`} className="row-link">
                        {line.name}
                      </Link>
                      <div className="muted mono">{line.sku}</div>
                    </td>
                    <td className="num">{formatQty(line.qty)}</td>
                    <td className="num">{formatQty(line.shipped)}</td>
                    <td>
                      <div className="badges">
                        {line.shipped >= line.qty && <span className="badge">Shipped</span>}
                        {line.reserved > 0 && <span className="badge badge-info">{formatQty(line.reserved)} ready</span>}
                        {open && line.backorder > 0 && (
                          <span className="badge badge-warn">{formatQty(line.backorder)} on backorder</span>
                        )}
                        {order.status === "quote" && (
                          <span className="muted">{formatQty(line.availableNow)} available</span>
                        )}
                      </div>
                    </td>
                    <td className="num">{formatMoney(line.unitPrice)}</td>
                    <td className="num strong">{formatMoney(line.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="grow-2 stack-panels">
          <section className="glass panel">
            <h2 className="label">Order total</h2>
            <div className="numeral">{formatMoney(order.total)}</div>
            <div className="total-rows">
              <div>
                <span className="muted">Subtotal</span>
                <span>{formatMoney(order.subtotal)}</span>
              </div>
              <div>
                <span className="muted">Tax {formatQty(Math.round(order.taxRate * 1e6) / 1e4)}%</span>
                <span>{formatMoney(order.tax)}</span>
              </div>
            </div>
            {order.notes && <p className="muted order-notes">{order.notes}</p>}
          </section>
          <section className="glass panel">
            <h2 className="label">Activity</h2>
            <div className="rows">
              {order.cancelledAt && (
                <div className="row">
                  <span className="dot" aria-hidden="true" />
                  <div className="row-text">
                    <div className="row-title">Order cancelled</div>
                    <div className="muted">{when.format(order.cancelledAt)}</div>
                  </div>
                </div>
              )}
              {order.shipments.map((shipment, index) => (
                <div className="row" key={shipment.id}>
                  <span className={`dot ${index === 0 ? "dot-white" : ""}`} aria-hidden="true" />
                  <div className="row-text">
                    <div className="row-title">
                      Shipment <span className="mono">{shipment.number}</span>
                    </div>
                    <div className="muted">
                      {when.format(shipment.shippedAt)} · {formatQty(shipment.units)} units · {shipment.shippedBy ?? "System"}
                    </div>
                  </div>
                </div>
              ))}
              {order.confirmedAt && (
                <div className="row">
                  <span className="dot" aria-hidden="true" />
                  <div className="row-text">
                    <div className="row-title">Order confirmed</div>
                    <div className="muted">{when.format(order.confirmedAt)}</div>
                  </div>
                </div>
              )}
              <div className="row">
                <span className="dot" aria-hidden="true" />
                <div className="row-text">
                  <div className="row-title">Quote created</div>
                  <div className="muted">
                    {when.format(order.createdAt)} · {order.ownerName ?? "Unknown"}
                  </div>
                </div>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
