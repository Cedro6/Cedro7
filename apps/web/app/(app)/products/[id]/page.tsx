import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getProduct, listMovements, type MovementKind } from "@bos/core";
import { formatMoney, formatQty } from "../../../../lib/format";
import { requireSession } from "../../../../lib/session";
import { saveAdjustment } from "./actions";

const kindLabel: Record<MovementKind, string> = {
  opening_balance: "Opening balance",
  adjustment: "Adjustment",
  receipt: "Received",
  shipment: "Shipped",
  return_in: "Customer return",
  return_out: "Returned to supplier",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
};

const when = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { ctx } = await requireSession();
  const { id } = await params;
  const { error, saved } = await searchParams;
  const product = await getProduct(ctx, id);
  if (!product) notFound();
  const movements = await listMovements(ctx, id);
  const canAdjust = can(ctx.role, "stock.adjust");
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Link href="/products">Products</Link> · <span className="mono">{product.sku}</span>
          </div>
          <h1>{product.name}</h1>
        </div>
        {product.lowStock && <span className="badge badge-warn badge-large">Low stock</span>}
      </header>

      <div className="tiles">
        <div className="glass panel tile">
          <h2 className="label">Available</h2>
          <div className="numeral">{formatQty(product.available)}</div>
          <div className="muted">
            {product.reorderPoint === null ? "No reorder point set" : `Reorder at ${formatQty(product.reorderPoint)}`}
          </div>
        </div>
        <div className="glass panel tile">
          <h2 className="label">On hand</h2>
          <div className="numeral">{formatQty(product.onHand)}</div>
          <div className="muted">Shelf {product.shelfLocation ?? "not set"}</div>
        </div>
        <div className="glass panel tile">
          <h2 className="label">Reserved</h2>
          <div className="numeral">{formatQty(product.reserved)}</div>
          <div className="muted">Set aside for orders</div>
        </div>
        <div className="glass panel tile">
          <h2 className="label">Price</h2>
          <div className="numeral">{formatMoney(product.price)}</div>
          <div className="muted">{product.cost === null ? product.category ?? "" : `Cost ${formatMoney(product.cost)}`}</div>
        </div>
      </div>

      <div className="split">
        <section className="glass panel grow-3">
          <h2 className="title">Stock history</h2>
          {movements.length === 0 ? (
            <p className="muted">No stock has moved yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="compact">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>What</th>
                    <th>By</th>
                    <th className="num">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.map((movement) => (
                    <tr key={movement.id}>
                      <td className="muted-cell">{when.format(movement.postedAt)}</td>
                      <td>
                        <div className="row-title">{kindLabel[movement.kind]}</div>
                        {movement.reason && movement.reason !== kindLabel[movement.kind] && (
                          <div className="muted">{movement.reason}</div>
                        )}
                      </td>
                      <td>{movement.postedBy ?? "System"}</td>
                      <td className={`num strong ${movement.qtyDelta < 0 ? "minus" : "plus"}`}>
                        {movement.qtyDelta > 0 ? "+" : "−"}
                        {formatQty(Math.abs(movement.qtyDelta))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {canAdjust && (
          <section className="glass panel grow-2">
            <h2 className="title">Adjust stock</h2>
            <form action={saveAdjustment} className="stack">
              <input type="hidden" name="productId" value={product.id} />
              <input type="hidden" name="requestId" value={randomUUID()} />
              {error && <p className="error">{error}</p>}
              {saved && !error && <p className="notice">Adjustment saved.</p>}
              <fieldset className="segmented segmented-form">
                <legend className="sr-only">Direction</legend>
                <label>
                  <input type="radio" name="direction" value="add" defaultChecked />
                  <span>Add</span>
                </label>
                <label>
                  <input type="radio" name="direction" value="remove" />
                  <span>Remove</span>
                </label>
              </fieldset>
              <label className="field">
                <span>Quantity</span>
                <input name="amount" type="number" min="0.0001" step="any" required inputMode="decimal" />
              </label>
              <label className="field">
                <span>Reason</span>
                <input name="reason" required maxLength={200} placeholder="Damaged, recount, found" />
              </label>
              <button type="submit" className="btn btn-primary">
                Save adjustment
              </button>
              <p className="muted">Adjustments are added to the history and cannot be edited afterwards.</p>
            </form>
          </section>
        )}
      </div>
    </>
  );
}
