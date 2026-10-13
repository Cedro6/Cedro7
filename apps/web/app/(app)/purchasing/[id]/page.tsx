import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getPurchaseOrder } from "@bos/core";
import { PoStatusBadge } from "../../../../components/PoStatusBadge";
import { formatMoney, formatQty } from "../../../../lib/format";
import { requireSession } from "../../../../lib/session";
import { approve, cancel, markSent, receive, submit } from "../actions";
import { zone } from "../../../../lib/locale";

const when = { format: (d: Date | number) => new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: zone(),
}).format(d) };
const day = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

export default async function PurchaseOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { ctx } = await requireSession();
  const { id } = await params;
  const { error, notice } = await searchParams;
  if (!can(ctx, "purchase_order.read")) notFound();
  const order = await getPurchaseOrder(ctx, id);
  if (!order) notFound();

  const canWrite = can(ctx, "purchase_order.write");
  const canApprove = can(ctx, "purchase_order.approve");
  const receivable = ["approved", "sent", "partially_received"].includes(order.status);
  const canReceive = receivable && can(ctx, "purchase_order.receive");
  const cancellable = ["draft", "pending_approval", "approved", "sent"].includes(order.status);
  const outstanding = order.unitsOrdered - order.unitsReceived;
  const showCost = order.total !== null;

  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Link href="/purchasing">Purchasing</Link> / {order.supplierName}
          </div>
          <div className="title-row">
            <h1>{order.number}</h1>
            <PoStatusBadge status={order.status} large />
          </div>
        </div>
        <Link href={`/purchasing/${order.id}/print`} className="btn btn-glass">Print or save as PDF</Link>
        {canWrite && cancellable && (
          <form action={cancel}>
            <input type="hidden" name="orderId" value={order.id} />
            <button type="submit" className="btn btn-glass">
              Cancel
            </button>
          </form>
        )}
        {canWrite && order.status === "draft" && (
          <form action={submit}>
            <input type="hidden" name="orderId" value={order.id} />
            <button type="submit" className="btn btn-primary">
              Submit
            </button>
          </form>
        )}
        {canApprove && order.status === "pending_approval" && (
          <form action={approve}>
            <input type="hidden" name="orderId" value={order.id} />
            <button type="submit" className="btn btn-primary">
              Approve
            </button>
          </form>
        )}
        {canWrite && order.status === "approved" && (
          <form action={markSent}>
            <input type="hidden" name="orderId" value={order.id} />
            <button type="submit" className="btn btn-primary">
              Mark as sent
            </button>
          </form>
        )}
      </header>

      {error && <p className="error">{error}</p>}
      {notice && !error && <p className="notice">{notice}</p>}

      <section className="glass panel">
        <div className="panel-head">
          <div>
            <span className="numeral">{formatQty(order.unitsReceived)}</span>
            <span className="numeral-caption"> of {formatQty(order.unitsOrdered)} units received</span>
          </div>
          <div className="legend">
            <span>Expected {order.expectedOn ? day.format(new Date(order.expectedOn)) : "date not set"}</span>
          </div>
        </div>
        <div className="meter meter-large" role="img" aria-label="Receiving progress">
          {order.unitsReceived > 0 && <span className="meter-shipped" style={{ flexGrow: order.unitsReceived }} />}
          {outstanding > 0 && <span className="meter-idle" style={{ flexGrow: outstanding }} />}
        </div>
        <p className="muted meter-note">
          {order.status === "draft" &&
            (showCost
              ? `Draft. Orders up to ${formatMoney(order.approvalLimit)} are approved on submit; larger ones need an owner or admin.`
              : "Draft. Not yet submitted.")}
          {order.status === "pending_approval" && "Waiting for an owner or admin to approve."}
          {order.status === "approved" && "Approved. Mark it as sent once the supplier has it. Sending by email is not built yet."}
          {order.status === "sent" && "With the supplier. Receive stock here when it arrives."}
          {order.status === "partially_received" && "Part of this order has arrived. Receive the rest when it comes in."}
          {order.status === "received" && "Everything on this order has been received."}
          {order.status === "cancelled" && "This purchase order was cancelled."}
        </p>
      </section>

      <div className="split">
        <section className="glass panel grow-3">
          <h2 className="title">{canReceive ? "Receive stock" : "Items"}</h2>
          <form action={receive}>
            <input type="hidden" name="orderId" value={order.id} />
            <input type="hidden" name="requestId" value={randomUUID()} />
            <div className="table-wrap">
              <table className="cards-on-phone">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num">Ordered</th>
                    <th className="num">Received</th>
                    {canReceive && <th className="num">Receive now</th>}
                    {showCost && <th className="num">Cost</th>}
                    {showCost && <th className="num">Amount</th>}
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
                      <td className="num" data-label="Ordered">{formatQty(line.qty)}</td>
                      <td className="num" data-label="Received">{formatQty(line.received)}</td>
                      {canReceive && (
                        <td className="num" data-label="Receive now">
                          {line.outstanding > 0 ? (
                            <>
                              <input type="hidden" name="lineId" value={line.id} />
                              <input
                                className="cell-input"
                                name="receiveQty"
                                type="number"
                                min="0"
                                max={line.outstanding}
                                step="any"
                                defaultValue={line.outstanding}
                                inputMode="decimal"
                                aria-label={`Quantity of ${line.name} to receive`}
                              />
                            </>
                          ) : (
                            <span className="badge">Complete</span>
                          )}
                        </td>
                      )}
                      {showCost && <td className="num" data-label="Cost">{formatMoney(line.unitCost ?? 0)}</td>}
                      {showCost && <td className="num strong" data-label="Amount">{formatMoney(line.amount ?? 0)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canReceive && (
              <div className="actions receive-actions">
                <button type="submit" className="btn btn-primary">
                  Receive these quantities
                </button>
                <span className="muted">Set a line to 0 if it did not arrive.</span>
              </div>
            )}
          </form>
        </section>

        <aside className="grow-2 stack-panels">
          {showCost && (
            <section className="glass panel">
              <h2 className="label">Order total</h2>
              <div className="numeral">{formatMoney(order.total ?? 0)}</div>
              {order.notes && <p className="muted order-notes">{order.notes}</p>}
            </section>
          )}
          <section className="glass panel">
            <h2 className="label">Activity</h2>
            <div className="rows">
              {order.cancelledAt && (
                <div className="row">
                  <span className="dot" aria-hidden="true" />
                  <div className="row-text">
                    <div className="row-title">Cancelled</div>
                    <div className="muted">{when.format(order.cancelledAt)}</div>
                  </div>
                </div>
              )}
              {order.receipts.map((receipt, index) => (
                <div className="row" key={receipt.id}>
                  <span className={`dot ${index === 0 ? "dot-white" : ""}`} aria-hidden="true" />
                  <div className="row-text">
                    <div className="row-title">
                      Receipt <span className="mono">{receipt.number}</span>
                    </div>
                    <div className="muted">
                      {when.format(receipt.receivedAt)} · {formatQty(receipt.units)} units · {receipt.receivedBy ?? "System"}
                    </div>
                  </div>
                </div>
              ))}
              {order.sentAt && (
                <div className="row">
                  <span className="dot" aria-hidden="true" />
                  <div className="row-text">
                    <div className="row-title">Sent to supplier</div>
                    <div className="muted">{when.format(order.sentAt)}</div>
                  </div>
                </div>
              )}
              {order.approvedAt && (
                <div className="row">
                  <span className="dot" aria-hidden="true" />
                  <div className="row-text">
                    <div className="row-title">Approved</div>
                    <div className="muted">
                      {when.format(order.approvedAt)} · {order.approvedBy ?? "Unknown"}
                    </div>
                  </div>
                </div>
              )}
              <div className="row">
                <span className="dot" aria-hidden="true" />
                <div className="row-text">
                  <div className="row-title">Draft created</div>
                  <div className="muted">
                    {when.format(order.createdAt)} · {order.createdBy ?? "Unknown"}
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
