import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, featureOn, getOrder, listInvoices, listReturnable, listReturns } from "@bos/core";
import { InvoiceBadge } from "../../../../components/InvoiceBadge";
import { StatusBadge } from "../../../../components/StatusBadge";
import { formatMoney, formatQty } from "../../../../lib/format";
import { requireSession } from "../../../../lib/session";
import { deposit } from "../../invoices/actions";
import { cancel, confirm, reserve, ship, takeReturn } from "../actions";
import { zone } from "../../../../lib/locale";

const when = { format: (d: Date | number) => new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: zone(),
}).format(d) };

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

  const canWrite = can(ctx, "sales_order.write");
  const canShip = can(ctx, "sales_order.ship");
  const open = order.status === "confirmed" || order.status === "partially_shipped";
  const tracked = featureOn(ctx.features, "stock");
  const invoices = await listInvoices(ctx, { orderId: order.id });
  const canDeposit =
    can(ctx, "invoice.write") &&
    (order.status === "quote" || order.status === "confirmed") &&
    !invoices.some((invoice) => invoice.kind === "deposit" && invoice.state !== "void");
  const returnsOn = featureOn(ctx.features, "returns") && order.unitsShipped > 0;
  const [returns, returnable] = returnsOn ? await Promise.all([listReturns(ctx, order.id), listReturnable(ctx, order.id)]) : [[], []];
  const canReturn = returnsOn && canWrite && returnable.some((l) => l.left > 0);
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
            <StatusBadge status={order.status} large tracked={tracked} />
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
        {tracked && canWrite && open && couldReserve > 0 && (
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
        {canShip && open && (tracked ? order.unitsReserved > 0 : true) && (
          <form action={ship}>
            <input type="hidden" name="orderId" value={order.id} />
            <input type="hidden" name="requestId" value={randomUUID()} />
            <button type="submit" className="btn btn-primary">
              {tracked ? "Ship what's ready" : "Complete order"}
            </button>
          </form>
        )}
      </header>

      {error && <p className="error">{error}</p>}
      {notice && !error && <p className="notice">{notice}</p>}

      {tracked && (
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
      )}

      <div className="split">
        <section className="glass panel grow-3">
          <h2 className="title">Items</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">{tracked ? "Ordered" : "Quantity"}</th>
                  {tracked && <th className="num">Shipped</th>}
                  {tracked && <th>Status</th>}
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
                    {tracked && <td className="num">{formatQty(line.shipped)}</td>}
                    {tracked && (
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
                    )}
                    <td className="num">
                      {formatMoney(line.unitPrice)}
                      {!line.taxable && order.taxRate > 0 && <div className="muted">Not taxed</div>}
                      {line.discountPercent > 0 ? (
                        <div className="muted">
                          {formatQty(line.discountPercent)}% off {formatMoney(line.listPrice)}
                        </div>
                      ) : null}
                    </td>
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
          {(invoices.length > 0 || canDeposit) && (
            <section className="glass panel">
              <div className="panel-head">
                <h2 className="label">Invoices</h2>
                <span className="muted">{tracked ? "One per shipment" : "Raised when the order is completed"}</span>
              </div>
              {invoices.length > 0 && (
                <div className="rows">
                  {invoices.map((invoice) => (
                    <div className="row" key={invoice.id}>
                      <div className="row-text">
                        <Link href={`/invoices/${invoice.id}`} className="row-link mono">
                          {invoice.number}
                        </Link>
                        <div className="muted">
                          {invoice.kind === "deposit" ? "Deposit · " : ""}
                          {invoice.balance > 0 && invoice.balance < invoice.amount ? `${formatMoney(invoice.balance)} still owed` : ""}
                        </div>
                      </div>
                      <InvoiceBadge state={invoice.state} />
                      <div className="strong">{formatMoney(invoice.amount)}</div>
                    </div>
                  ))}
                </div>
              )}
              {canDeposit && (
                <details className="disclosure disclosure-flat">
                  <summary>Ask for a deposit</summary>
                  <form action={deposit} className="inline-form">
                    <input type="hidden" name="orderId" value={order.id} />
                    <label className="sr-only" htmlFor="deposit-percent">
                      Deposit percent
                    </label>
                    <input id="deposit-percent" name="percent" type="number" min="1" max="99" step="any" required placeholder="Percent, for example 30" />
                    <button type="submit" className="btn btn-glass btn-small">
                      Raise deposit invoice
                    </button>
                  </form>
                  <p className="muted">It is taken off the invoices that follow.</p>
                </details>
              )}
            </section>
          )}
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
                      {tracked ? (
                        <>
                          Shipment <span className="mono">{shipment.number}</span>
                        </>
                      ) : (
                        "Order completed"
                      )}
                    </div>
                    <div className="muted">
                      {when.format(shipment.shippedAt)} · {formatQty(shipment.units)} units · {shipment.shippedBy ?? "System"}
                    </div>
                  </div>
                  {tracked && (
                    <Link href={`/sales/${order.id}/packing-slip/${shipment.id}`} className="btn btn-glass btn-small">
                      Packing slip
                    </Link>
                  )}
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

      {returnsOn && (returns.length > 0 || canReturn) && (
        <section className="glass panel" id="returns">
          <h2 className="title">Returns</h2>
          {returns.length > 0 && (
            <div className="rows">
              {returns.map((r) => (
                <div className="row" key={r.id}>
                  <span className="dot" aria-hidden="true" />
                  <div className="row-text">
                    <div className="row-title">
                      <span className="mono">{r.number}</span> · {r.lines.map((l) => `${formatQty(l.qty)} × ${l.name}`).join(", ")}
                    </div>
                    <div className="muted">
                      {when.format(r.returnedAt)} · {r.byName ?? "System"} · {r.reason} · {r.restocked ? "back in stock" : "not restocked"}
                      {r.creditNoteNumber ? ` · credit note ${r.creditNoteNumber} for ${formatMoney(r.creditAmount ?? 0)}` : " · no credit raised"}
                    </div>
                  </div>
                  <span className="strong">{formatMoney(r.value)}</span>
                </div>
              ))}
            </div>
          )}
          {canReturn && (
            <details className="return-form">
              <summary className="btn btn-glass btn-small">Take a return</summary>
              <form action={takeReturn} className="stack">
                <input type="hidden" name="orderId" value={order.id} />
                <input type="hidden" name="requestId" value={randomUUID()} />
                <div className="table-wrap">
                  <table className="compact">
                    <thead>
                      <tr><th>Product</th><th className="num">Shipped</th><th className="num">Already returned</th><th className="num">Coming back now</th></tr>
                    </thead>
                    <tbody>
                      {returnable.filter((l) => l.left > 0).map((l) => (
                        <tr key={l.orderLineId}>
                          <td>{l.name} <span className="muted mono">{l.sku}</span></td>
                          <td className="num">{formatQty(l.shipped)}</td>
                          <td className="num">{formatQty(l.returned)}</td>
                          <td className="num">
                            <input type="hidden" name="orderLineId" value={l.orderLineId} />
                            <input className="return-qty" name="returnQty" type="number" min="0" max={l.left} step="any" inputMode="decimal" placeholder="0" aria-label={`How many ${l.name} came back, up to ${formatQty(l.left)}`} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <label className="field">
                  <span>Why did it come back?</span>
                  <input name="reason" required maxLength={200} placeholder="Wrong size, damaged, changed their mind" />
                </label>
                {tracked && (
                  <label className="bill-choice">
                    <input type="checkbox" name="restock" value="1" defaultChecked /> <span>Put it back in stock (untick for damaged goods)</span>
                  </label>
                )}
                {can(ctx, "invoice.write") && (
                  <label className="bill-choice">
                    <input type="checkbox" name="credit" value="1" defaultChecked /> <span>Raise a credit note for its value, tax included</span>
                  </label>
                )}
                <p className="muted">The credit comes off this order&apos;s unpaid invoice if there is one. Otherwise it stays on the customer&apos;s account for their next invoice.</p>
                <div className="actions">
                  <button type="submit" className="btn btn-primary">Record return</button>
                </div>
              </form>
            </details>
          )}
        </section>
      )}
    </>
  );
}
