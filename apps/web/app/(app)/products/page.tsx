import Link from "next/link";
import { can, featureOn, listArchivedProducts, listProducts } from "@bos/core";
import { SearchIcon } from "../../../components/icons";
import { formatMoney, formatQty } from "../../../lib/format";
import { requireSession } from "../../../lib/session";

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ q?: string; low?: string; archived?: string; notice?: string }> }) {
  const { ctx } = await requireSession();
  const { q = "", low, archived, notice } = await searchParams;
  const showArchived = archived === "1";
  const tracked = featureOn(ctx.features, "stock");
  const lowOnly = low === "1" && !showArchived;
  const products = showArchived ? await listArchivedProducts(ctx) : await listProducts(ctx, { search: q, lowStockOnly: lowOnly });
  const showCost = can(ctx, "product.cost.view");
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            {products.length} {products.length === 1 ? "product" : "products"}
            {lowOnly ? " running low" : showArchived ? " archived" : ""}
          </div>
          <h1>Products</h1>
        </div>
        <div className="segmented" role="group" aria-label="Filter">
          <Link href="/products" aria-current={lowOnly || showArchived ? undefined : "true"}>
            All
          </Link>
          {tracked && (
            <Link href="/products?low=1" aria-current={lowOnly ? "true" : undefined}>
              Low stock
            </Link>
          )}
          <Link href="/products?archived=1" aria-current={showArchived ? "true" : undefined}>
            Archived
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
        {can(ctx, "product.write") && (
          <Link href="/products/new" className="btn btn-primary">
            New product
          </Link>
        )}
      </header>
      {notice && <p className="notice">{notice}</p>}
      <section className="glass panel">
        {products.length === 0 ? (
          <div className="empty">
            <div className="empty-title">
              {showArchived ? "Nothing archived" : q ? "No products match that search" : lowOnly ? "Nothing is running low" : "No products yet"}
            </div>
            <p>
              {showArchived
                ? "Products you archive are kept here."
                : q
                ? "Try part of the name or SKU."
                : lowOnly
                  ? "Every product is above its reorder point."
                  : "Add your first product to get started."}
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
                      <Link href={showArchived ? `/products/${product.id}/edit` : `/products/${product.id}`} className="row-link">
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
