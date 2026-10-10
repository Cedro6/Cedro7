import Link from "next/link";
import { redirect } from "next/navigation";
import { can, listPriceLists, listProducts } from "@bos/core";
import { formatMoney, formatQty } from "../../../../lib/format";
import { requireSession } from "../../../../lib/session";
import { removePriceList, savePriceList } from "../actions";

export default async function PriceListsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { ctx } = await requireSession();
  if (!can(ctx, "sales_order.read")) redirect("/");
  const { error, notice } = await searchParams;
  const canWrite = can(ctx, "sales_order.write");
  const [lists, products] = await Promise.all([listPriceLists(ctx), listProducts(ctx)]);
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Link href="/sales">Sales</Link>
          </div>
          <h1>Price lists</h1>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      {notice && !error && <p className="notice">{notice}</p>}
      <div className="split">
        <section className="glass panel grow-3">
          {lists.length === 0 ? (
            <div className="empty">
              <div className="empty-title">No price lists yet</div>
              <p>Everyone pays the list price. Create a price list to give a group of customers their own prices.</p>
            </div>
          ) : (
            <div className="rows">
              {lists.map((list) => (
                <div className="row row-top" key={list.id}>
                  <div className="row-text">
                    <div className="row-title">{list.name}</div>
                    <div className="muted">
                      {list.percentOff > 0 ? `${formatQty(list.percentOff)}% off everything` : "No percentage off"} ·{" "}
                      {list.customers} {list.customers === 1 ? "customer" : "customers"}
                    </div>
                    {list.specialPrices.map((special) => (
                      <div className="muted" key={special.productId}>
                        {special.name} at {formatMoney(special.price)}
                      </div>
                    ))}
                  </div>
                  {canWrite && (
                    <form action={removePriceList}>
                      <input type="hidden" name="priceListId" value={list.id} />
                      <button type="submit" className="btn btn-glass btn-small" aria-label={`Delete ${list.name}`}>
                        Delete
                      </button>
                    </form>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="muted footnote">
            Put a customer on a list from the customer&apos;s page. Deleting a list puts its customers back on list prices; orders already
            written keep the prices they were given.
          </p>
        </section>
        {canWrite && (
          <aside className="grow-2">
            <section className="glass panel">
              <h2 className="title">New price list</h2>
              <form action={savePriceList} className="stack">
                <label className="field">
                  <span>Name</span>
                  <input name="name" required maxLength={100} placeholder="Contractor pricing" />
                </label>
                <label className="field">
                  <span>Percentage off every product</span>
                  <input name="percentOff" type="number" min="0" max="99.99" step="any" inputMode="decimal" placeholder="0" />
                </label>
                {[1, 2, 3].map((n) => (
                  <div className="form-row" key={n}>
                    <label className="field grow">
                      <span>{n === 1 ? "Special price for (optional)" : <span className="sr-only">Special price product {n}</span>}</span>
                      <select name="specialProductId" defaultValue="">
                        <option value="">No product</option>
                        {products.map((product) => (
                          <option key={product.id} value={product.id}>
                            {product.sku} · {product.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field tax-field">
                      <span>{n === 1 ? "Price" : <span className="sr-only">Special price {n}</span>}</span>
                      <input name="specialPrice" type="number" min="0" step="any" inputMode="decimal" />
                    </label>
                  </div>
                ))}
                <button type="submit" className="btn btn-primary">
                  Save price list
                </button>
              </form>
            </section>
          </aside>
        )}
      </div>
    </>
  );
}
