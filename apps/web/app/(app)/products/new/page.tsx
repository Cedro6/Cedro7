import Link from "next/link";
import { redirect } from "next/navigation";
import { can, featureOn } from "@bos/core";
import { ProductFields } from "../../../../components/ProductFields";
import { requireSession } from "../../../../lib/session";
import { newProduct } from "../../records-actions";

export default async function NewProductPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "product.write")) redirect("/products");
  const { error } = await searchParams;
  const tracked = featureOn(ctx.features, "stock");
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Link href="/products">Products</Link>
          </div>
          <h1>New product</h1>
        </div>
      </header>
      <section className="glass panel form-panel">
        <form action={newProduct} className="stack">
          {error && <p className="error">{error}</p>}
          <ProductFields showCost={can(ctx, "product.cost.view")} tracked={tracked} />
          {tracked && <p className="muted">The product starts with no stock. Add what you have on the product's page after saving.</p>}
          <div className="actions">
            <button type="submit" className="btn btn-primary">Save product</button>
            <Link href="/products" className="btn btn-glass">Cancel</Link>
          </div>
        </form>
      </section>
    </>
  );
}
