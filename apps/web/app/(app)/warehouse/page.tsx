import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import { can, countCategories, countSheet, featureOn, lookupProduct, pickQueue, putawayList } from "@bos/core";
import { ScanBox } from "../../../components/ScanBox";
import { PickList } from "../../../components/PickList";
import { formatQty } from "../../../lib/format";
import { requireSession } from "../../../lib/session";
import { ship } from "../sales/actions";
import { putAway, saveCount } from "./actions";

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

export default async function WarehousePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; order?: string; category?: string; shelf?: string; code?: string; error?: string; notice?: string }>;
}) {
  const { ctx } = await requireSession();
  const stock = featureOn(ctx.features, "stock");
  const tabs = [
    { key: "pick", label: "Pick", on: stock && featureOn(ctx.features, "picking") && can(ctx, "sales_order.ship") },
    { key: "putaway", label: "Put away", on: stock && featureOn(ctx.features, "putaway") && can(ctx, "purchase_order.receive") },
    { key: "count", label: "Count", on: stock && featureOn(ctx.features, "counts") && can(ctx, "stock.adjust") },
    { key: "lookup", label: "Look up", on: stock && featureOn(ctx.features, "warehouse") && can(ctx, "product.read") },
  ].filter((tab) => tab.on);
  if (tabs.length === 0) redirect("/");
  const params = await searchParams;
  const tab = tabs.find((t) => t.key === params.tab) ?? tabs[0]!;

  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">Warehouse</div>
          <h1>{tab.key === "pick" ? "Pick and ship" : tab.key === "putaway" ? "Put away" : tab.key === "count" ? "Stock count" : "Look up a product"}</h1>
        </div>
        {tabs.length > 1 && (
          <div className="segmented" role="group" aria-label="Warehouse job">
            {tabs.map((t) => (
              <Link key={t.key} href={`/warehouse?tab=${t.key}`} aria-current={t.key === tab.key ? "true" : undefined}>
                {t.label}
              </Link>
            ))}
          </div>
        )}
      </header>
      {params.error && <p className="error">{params.error}</p>}
      {params.notice && !params.error && <p className="notice">{params.notice}</p>}
      {tab.key === "pick" && <Pick orderId={params.order} />}
      {tab.key === "putaway" && <Putaway />}
      {tab.key === "count" && <Count category={params.category ?? ""} shelf={params.shelf ?? ""} />}
      {tab.key === "lookup" && <Lookup code={params.code ?? ""} />}
    </>
  );
}

async function Pick({ orderId }: { orderId?: string }) {
  const { ctx } = await requireSession();
  const queue = await pickQueue(ctx);
  if (queue.length === 0) {
    return (
      <section className="glass panel empty">
        <div className="empty-title">Nothing to pick</div>
        <p>Orders show up here once they are confirmed and have stock reserved.</p>
      </section>
    );
  }
  const open = queue.find((o) => o.id === orderId) ?? queue[0]!;
  return (
    <div className="split">
      <section className="glass panel grow-2">
        <h2 className="title">Waiting</h2>
        <div className="rows">
          {queue.map((order) => (
            <Link key={order.id} href={`/warehouse?tab=pick&order=${order.id}`} className={`row row-pick ${order.id === open.id ? "is-current" : ""}`}>
              <div className="row-text">
                <div className="row-title mono">{order.number}</div>
                <div className="muted">{order.customer}</div>
              </div>
              <div className="muted pick-meta">
                <span>{formatQty(order.units)} units</span>
                {order.confirmedAt && <span>{day.format(order.confirmedAt)}</span>}
              </div>
            </Link>
          ))}
        </div>
      </section>
      <section className="glass panel grow-3">
        <div className="panel-head">
          <div>
            <h2 className="title">
              <Link href={`/sales/${open.id}`} className="row-link mono">
                {open.number}
              </Link>{" "}
              · {open.customer}
            </h2>
            {open.backorder > 0 && (
              <div className="muted">{formatQty(open.backorder)} units have no stock yet and stay on the order.</div>
            )}
          </div>
        </div>
        <PickList key={open.id} lines={open.lines}>
          <form action={ship}>
            <input type="hidden" name="orderId" value={open.id} />
            <input type="hidden" name="requestId" value={randomUUID()} />
            <button type="submit" className="btn btn-primary">
              Ship {formatQty(open.units)} units
            </button>
          </form>
        </PickList>
      </section>
    </div>
  );
}

async function Putaway() {
  const { ctx } = await requireSession();
  const lines = await putawayList(ctx);
  if (lines.length === 0) {
    return (
      <section className="glass panel empty">
        <div className="empty-title">Nothing waiting at the dock</div>
        <p>Goods you receive on a purchase order show up here until they are on their shelves.</p>
      </section>
    );
  }
  return (
    <section className="glass panel">
      <div className="muted">
        {lines.length} {lines.length === 1 ? "line" : "lines"} to put away
      </div>
      <div className="rows">
        {lines.map((line) => (
          <form action={putAway} className="row" key={line.id}>
            <input type="hidden" name="lineId" value={line.id} />
            <div className="row-text">
              <div className="row-title">
                {formatQty(line.qty)} × {line.name}
              </div>
              <div className="muted">
                <span className="mono">{line.sku}</span> · {line.supplier} · {line.receipt} · {day.format(line.receivedAt)}
              </div>
            </div>
            {line.shelf ? (
              <span className="pick-shelf mono">{line.shelf}</span>
            ) : (
              <label className="shelf-input">
                <span className="sr-only">Shelf for {line.name}</span>
                <input name="shelf" maxLength={50} placeholder="Shelf" required />
              </label>
            )}
            <button type="submit" className="btn btn-glass btn-small">
              Put away
            </button>
          </form>
        ))}
      </div>
    </section>
  );
}

async function Count({ category, shelf }: { category: string; shelf: string }) {
  const { ctx } = await requireSession();
  const [lines, categories] = await Promise.all([countSheet(ctx, { category, shelfPrefix: shelf }), countCategories(ctx)]);
  return (
    <>
      <section className="glass panel">
        <form className="form-row count-filter">
          <input type="hidden" name="tab" value="count" />
          <label className="field">
            <span>Category</span>
            <select name="category" defaultValue={category}>
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Shelf starts with</span>
            <input name="shelf" defaultValue={shelf} maxLength={50} placeholder="A-" />
          </label>
          <button type="submit" className="btn btn-glass">
            Show
          </button>
        </form>
      </section>
      <section className="glass panel">
        {lines.length === 0 ? (
          <div className="empty">
            <div className="empty-title">No products match</div>
            <p>Try a different category or shelf.</p>
          </div>
        ) : (
          <form action={saveCount} className="stack">
            <input type="hidden" name="requestId" value={randomUUID()} />
            <input type="hidden" name="category" value={category} />
            <input type="hidden" name="shelf" value={shelf} />
            <p className="muted">
              Type what is actually on the shelf. Leave a box empty to skip that product. Saving corrects the stock for every product whose count differs.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Shelf</th>
                    <th>Product</th>
                    <th className="num">Recorded</th>
                    <th className="num">Counted</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.productId}>
                      <td className="mono">{line.shelf ?? ""}</td>
                      <td>
                        {line.name}
                        <div className="muted mono">{line.sku}</div>
                      </td>
                      <td className="num">
                        {formatQty(line.onHand)}
                        {line.reserved > 0 && <div className="muted">{formatQty(line.reserved)} reserved</div>}
                      </td>
                      <td className="num">
                        <input type="hidden" name="productId" value={line.productId} />
                        <input
                          name="counted"
                          type="number"
                          min="0"
                          step="any"
                          inputMode="decimal"
                          className="count-input"
                          aria-label={`Counted quantity of ${line.name}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label className="field">
              <span>Note (optional)</span>
              <input name="note" maxLength={150} placeholder="Aisle A, monthly count" />
            </label>
            <div className="actions">
              <button type="submit" className="btn btn-primary">
                Save count
              </button>
            </div>
          </form>
        )}
      </section>
    </>
  );
}

async function Lookup({ code }: { code: string }) {
  const { ctx } = await requireSession();
  const found = code ? await lookupProduct(ctx, code) : null;
  const one = found && found.products.length === 1 ? found.products[0]! : null;
  return (
    <>
      <section className="glass panel">
        <ScanBox initial={code} />
        <p className="muted footnote">A handheld scanner types the code and presses Enter for you, so just scan. You can also type a barcode, a product code or part of a name.</p>
      </section>
      {found && found.products.length === 0 && (
        <section className="glass panel empty">
          <div className="empty-title">Nothing matches “{code}”</div>
          <p>
            If this is a product you stock, open it under Products, choose Edit, and scan this code into its Barcode box. After that a scan finds it.
          </p>
        </section>
      )}
      {one && (
        <section className="glass panel">
          <div className="panel-head">
            <div>
              <h2 className="title">
                <Link href={`/products/${one.id}`} className="row-link">
                  {one.name}
                </Link>
              </h2>
              <div className="muted mono">
                {one.sku}
                {one.barcode ? ` · ${one.barcode}` : ""}
              </div>
            </div>
            {one.lowStock && <span className="badge badge-warn badge-large">Low stock</span>}
          </div>
          <div className="tiles">
            <div className="glass panel tile">
              <h3 className="label">Shelf</h3>
              <div className="numeral numeral-md mono">{one.shelfLocation ?? "None"}</div>
            </div>
            <div className="glass panel tile">
              <h3 className="label">Available</h3>
              <div className="numeral">{formatQty(one.available)}</div>
              <div className="muted">
                {formatQty(one.onHand)} on hand · {formatQty(one.reserved)} reserved
              </div>
            </div>
            <div className="glass panel tile">
              <h3 className="label">On order</h3>
              <div className="numeral">{formatQty(one.onOrder)}</div>
              <div className="muted">{one.reorderPoint === null ? "No reorder point" : `Reorder at ${formatQty(one.reorderPoint)}`}</div>
            </div>
          </div>
          {!one.barcode && found?.match !== "barcode" && can(ctx, "product.write") && (
            <p className="muted footnote">
              This product has no barcode saved. <Link href={`/products/${one.id}/edit`}>Add one</Link> so a scan finds it.
            </p>
          )}
        </section>
      )}
      {found && found.products.length > 1 && (
        <section className="glass panel">
          <div className="muted">{found.products.length} products match “{code}”</div>
          <div className="rows">
            {found.products.map((product) => (
              <Link key={product.id} href={`/warehouse?tab=lookup&code=${encodeURIComponent(product.sku)}`} className="row row-pick">
                <div className="row-text">
                  <div className="row-title">{product.name}</div>
                  <div className="muted mono">{product.sku}</div>
                </div>
                <div className="muted pick-meta">
                  <span>{formatQty(product.available)} available</span>
                  <span className="mono">{product.shelfLocation ?? ""}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
