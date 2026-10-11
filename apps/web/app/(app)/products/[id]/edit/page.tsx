import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { can, featureOn, getProduct, productStatus } from "@bos/core";
import { ProductFields } from "../../../../../components/ProductFields";
import { requireSession } from "../../../../../lib/session";
import { archiveProduct, editProduct } from "../../../records-actions";

export default async function EditProductPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { ctx } = await requireSession();
  const { id } = await params;
  if (!can(ctx, "product.write")) redirect(`/products/${id}`);
  const [product, status] = await Promise.all([getProduct(ctx, id), productStatus(ctx, id)]);
  if (!product) notFound();
  const { error } = await searchParams;
  const archived = status === "archived";
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Link href="/products">Products</Link> · <Link href={`/products/${id}`}>{product.name}</Link>
          </div>
          <h1>Edit product</h1>
        </div>
        {archived && <span className="badge badge-warn badge-large">Archived</span>}
      </header>
      {error && <p className="error">{error}</p>}
      <section className="glass panel form-panel">
        <form action={editProduct} className="stack">
          <input type="hidden" name="id" value={id} />
          <ProductFields product={product} showCost={can(ctx, "product.cost.view")} tracked={featureOn(ctx.features, "stock")} />
          <div className="actions">
            <button type="submit" className="btn btn-primary">Save</button>
            <Link href={`/products/${id}`} className="btn btn-glass">Cancel</Link>
          </div>
        </form>
      </section>
      <section className="glass panel form-panel">
        <h2 className="title">{archived ? "Restore this product" : "Archive this product"}</h2>
        <p className="muted">
          {archived
            ? "Restoring puts the product back in your lists so it can be sold again."
            : "Archiving hides the product from lists and new orders. Its history is kept, and you can restore it any time."}
        </p>
        <form action={archiveProduct} className="actions">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="archived" value={archived ? "0" : "1"} />
          <button type="submit" className={`btn btn-glass ${archived ? "" : "btn-danger"}`}>{archived ? "Restore product" : "Archive product"}</button>
        </form>
      </section>
    </>
  );
}
