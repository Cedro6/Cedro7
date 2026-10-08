import Link from "next/link";
import { redirect } from "next/navigation";
import { can, listProducts, listSuppliers } from "@bos/core";
import { PurchaseLinesEditor } from "../../../../components/PurchaseLinesEditor";
import { requireSession } from "../../../../lib/session";
import { savePurchaseOrder } from "../actions";

export default async function NewPurchaseOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; low?: string }>;
}) {
  const { ctx } = await requireSession();
  if (!can(ctx.role, "purchase_order.write")) redirect("/purchasing");
  const { error, low } = await searchParams;
  const [suppliers, products] = await Promise.all([listSuppliers(ctx), listProducts(ctx)]);
  // Suggestion: bring available plus on-order stock up to twice the reorder point.
  const suggested =
    low === "1"
      ? products.flatMap((product) => {
          if (product.reorderPoint === null) return [];
          const covered = product.available + product.onOrder;
          if (covered > product.reorderPoint) return [];
          const qty = Math.ceil(product.reorderPoint * 2 - covered);
          return qty > 0 ? [{ productId: product.id, qty }] : [];
        })
      : [];
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Link href="/purchasing">Purchasing</Link>
          </div>
          <h1>New purchase order</h1>
        </div>
      </header>
      <form action={savePurchaseOrder} className="stack">
        {error && <p className="error">{error}</p>}
        {low === "1" && (
          <p className="notice">
            {suggested.length > 0
              ? `Filled in ${suggested.length} low products. Each quantity brings stock up to twice its reorder point; change anything before saving.`
              : "Nothing needs reordering: every low product is already covered by stock on order."}
          </p>
        )}
        <section className="glass panel">
          <div className="form-row">
            <label className="field grow">
              <span>Supplier</span>
              <select name="supplierId" required defaultValue="">
                <option value="">Choose a supplier</option>
                {suppliers.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field date-field">
              <span>Expected delivery</span>
              <input name="expectedOn" type="date" />
            </label>
          </div>
        </section>
        <section className="glass panel">
          <h2 className="title">Items</h2>
          <PurchaseLinesEditor
            initial={suggested}
            products={products.map((product) => ({
              id: product.id,
              sku: product.sku,
              name: product.name,
              cost: product.cost ?? 0,
              available: product.available,
              onOrder: product.onOrder,
            }))}
          />
        </section>
        <section className="glass panel">
          <label className="field">
            <span>Notes (optional)</span>
            <input name="notes" maxLength={2000} />
          </label>
        </section>
        <div className="actions">
          <button type="submit" className="btn btn-primary">
            Save as draft
          </button>
          <Link href="/purchasing" className="btn btn-glass">
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
