import { can, listProducts } from "@bos/core";
import { SearchIcon } from "../../../components/icons";
import { formatMoney } from "../../../lib/format";
import { requireSession } from "../../../lib/session";

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { ctx } = await requireSession();
  const { q = "" } = await searchParams;
  const products = await listProducts(ctx, { search: q });
  const showCost = can(ctx.role, "product.cost.view");
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            {products.length} {products.length === 1 ? "product" : "products"}
          </div>
          <h1>Products</h1>
        </div>
        <form className="glass search" role="search">
          <SearchIcon />
          <label className="sr-only" htmlFor="q">
            Search products
          </label>
          <input id="q" name="q" type="search" placeholder="Search name or SKU" defaultValue={q} />
        </form>
      </header>
      <section className="glass panel">
        {products.length === 0 ? (
          <div className="empty">
            <div className="empty-title">{q ? "No products match that search" : "No products yet"}</div>
            <p>{q ? "Try part of the name or SKU." : "Products are added by import in stage 7."}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Category</th>
                  <th>Shelf</th>
                  {showCost && <th className="num">Cost</th>}
                  <th className="num">Price</th>
                  {showCost && <th className="num">Margin</th>}
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td>
                      <div className="row-title">{product.name}</div>
                      <div className="muted mono">{product.sku}</div>
                    </td>
                    <td>{product.category ?? <span className="muted">None</span>}</td>
                    <td className="mono">{product.shelfLocation ?? ""}</td>
                    {showCost && <td className="num">{product.cost === null ? "" : formatMoney(product.cost)}</td>}
                    <td className="num strong">{formatMoney(product.price)}</td>
                    {showCost && (
                      <td className="num">
                        {product.cost !== null && product.price > 0
                          ? `${Math.round(((product.price - product.cost) / product.price) * 100)}%`
                          : ""}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="muted footnote">Stock on hand appears here once the stock ledger is built in stage 3.</p>
    </>
  );
}
