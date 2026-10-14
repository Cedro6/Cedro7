import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { can, featureOn, getOrder, getRegion, listCustomers, listProducts, pricesForCustomer } from "@bos/core";
import { OrderLinesEditor } from "../../../../../components/OrderLinesEditor";
import { requireSession } from "../../../../../lib/session";
import { saveOrderEdit } from "../../actions";

/** Changes a quote, or an order that has not shipped anything yet. */
export default async function EditOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "sales_order.write")) redirect("/sales");
  const { id } = await params;
  const { error } = await searchParams;
  const order = await getOrder(ctx, id);
  if (!order) notFound();
  if (order.status !== "quote" && order.status !== "confirmed") redirect(`/sales/${id}?error=${encodeURIComponent("An order that has shipped cannot be changed. Record a return instead.")}`);
  if (order.unitsShipped > 0) redirect(`/sales/${id}?error=${encodeURIComponent("Part of this order has shipped, so it cannot be changed. Record a return instead.")}`);

  const region = await getRegion(ctx);
  const [customers, products] = await Promise.all([listCustomers(ctx), listProducts(ctx)]);
  const tracked = featureOn(ctx.features, "stock");
  const onLists = customers.filter((option) => option.priceListId);
  const customerPrices = Object.fromEntries(
    await Promise.all(onLists.map(async (option) => [option.id, await pricesForCustomer(ctx, option.id)] as const)),
  );
  const taxPercent = Math.round(order.taxRate * 10000) / 100;
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow"><Link href="/sales">Sales</Link> / <Link href={`/sales/${order.id}`}>{order.number}</Link></div>
          <h1>Change {order.status === "quote" ? "quote" : "order"} {order.number}</h1>
        </div>
      </header>
      <form action={saveOrderEdit} className="stack">
        <input type="hidden" name="orderId" value={order.id} />
        {error && <p className="error">{error}</p>}
        <section className="glass panel">
          <div className="form-row">
            <label className="field grow">
              <span>Customer</span>
              <select name="customerId" required defaultValue={order.customerId}>
                {customers.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}{option.priceListName ? ` · ${option.priceListName}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field tax-field">
              <span>Tax %</span>
              <input name="taxRatePercent" type="number" min="0" max="99" step="any" inputMode="decimal" defaultValue={taxPercent} placeholder={`Usual (${region.defaultTaxPercent}%)`} />
            </label>
          </div>
        </section>
        <section className="glass panel">
          <h2 className="title">Items</h2>
          <OrderLinesEditor
            currency={ctx.currency ?? "USD"}
            tracked={tracked}
            customerPrices={customerPrices}
            initialCustomer={order.customerId}
            initialLines={order.lines.map((line) => ({ productId: line.productId, qty: line.qty, discountPercent: line.discountPercent }))}
            products={products.map((product) => ({ id: product.id, sku: product.sku, name: product.name, price: product.price, available: product.available }))}
          />
        </section>
        <section className="glass panel">
          <label className="field">
            <span>Notes (optional)</span>
            <input name="notes" maxLength={2000} defaultValue={order.notes ?? ""} />
          </label>
        </section>
        <div className="actions">
          <button type="submit" className="btn btn-primary">Save changes</button>
          <Link href={`/sales/${order.id}`} className="btn btn-glass">Cancel</Link>
        </div>
        <p className="muted footnote">
          {order.status === "confirmed" && tracked
            ? "This order holds stock. Saving gives back what it holds now and takes what the new quantities need, so stock stays right."
            : "Nothing is reserved by a quote, so changing it costs nothing."}
        </p>
      </form>
    </>
  );
}
