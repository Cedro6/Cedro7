import Link from "next/link";
import { can, listProducts } from "@bos/core";
import { SearchIcon } from "../../../components/icons";
import { formatMoney, formatQty } from "../../../lib/format";
import { requireSession } from "../../../lib/session";

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ q?: string; low?: string }> }) {
  const { ctx } = await requireSession();
  const { q = "", low } = await searchParams;
  const lowOnly = low === "1";
  const products = await listProducts(ctx, { search: q, lowStockOnly: lowOnly });
  const showCost = can(ctx.role, "product.cost.view");
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            {products.length} {products.length === 1 ? "product" : "products"}
            {lowOnly ? " running low" : ""}
          </div>
          <h1>Products</h1>
        </div>
        <div className="segmented" role="group" aria-label="Filter">
          <Link href="/products" aria-current={lowOnly ? undefined : "true"}>
            All
          </Link>
          <Link href="/products?low=1" aria-current={lowOnly ? "true" : undefined}>
            Low stock
          </Link>
        </div>
        <form className="glass search" role="search">
          <SearchIcon />
          <label className="sr-only" htmlFor="q">
            Search products
          </label>
          <input id="q" name="q" type="search" placeholder="Search name or SKU" defaultValue={q} />
          {lowOnly && <input type="hidden" name="low" value="1" />}
        </form>
      </header>
      <section className="glass panel">
        {products.length === 0 ? (
          <div className="empty">
            <div className="empty-title">
              {q ? "No products match that search" : lowOnly ? "Nothing is running low" : "No products yet"}
            </div>
            <p>
              {q
                ? "Try part of the name or SKU."
                : lowOnly
                  ? "Every product is above its reorder point."
                  : "Products are added by import in stage 7."}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Shelf</th>
                  <th className="num">On hand</th>
                  <th className="num">Reserved</th>
                  <th className="num">Available</th>
                  {showCost && <th className="num">Cost</th>}
                  <th className="num">Price</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td>
                      <Link href={`/products/${product.id}`} className="row-link">
                        {product.name}
                      </Link>
                      <div className="muted mono">{product.sku}</div>
                    </td>
                    <td className="mono">{product.shelfLocation ?? ""}</td>
                    <td className="num">{formatQty(product.onHand)}</td>
                    <td className="num muted-cell">{formatQty(product.reserved)}</td>
                    <td className="num strong">
                      {product.lowStock && <span className="badge badge-warn">Low</span>} {formatQty(product.available)}
                      {product.onOrder > 0 && <div className="muted">+{formatQty(product.onOrder)} on order</div>}
                    </td>
                    {showCost && <td className="num">{product.cost === null ? "" : formatMoney(product.cost)}</td>}
                    <td className="num">{formatMoney(product.price)}</td>
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
