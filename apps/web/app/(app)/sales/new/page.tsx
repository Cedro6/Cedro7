import Link from "next/link";
import { redirect } from "next/navigation";
import { can, featureOn, listCustomers, listProducts, pricesForCustomer } from "@bos/core";
import { OrderLinesEditor } from "../../../../components/OrderLinesEditor";
import { requireSession } from "../../../../lib/session";
import { saveQuote } from "../actions";

export default async function NewOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; customer?: string }>;
}) {
  const { ctx } = await requireSession();
  if (!can(ctx, "sales_order.write")) redirect("/sales");
  const { error, customer } = await searchParams;
  const [customers, products] = await Promise.all([listCustomers(ctx), listProducts(ctx)]);
  const tracked = featureOn(ctx.features, "stock");
  const onLists = customers.filter((option) => option.priceListId);
  const customerPrices = Object.fromEntries(
    await Promise.all(onLists.map(async (option) => [option.id, await pricesForCustomer(ctx, option.id)] as const)),
  );
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Link href="/sales">Sales</Link>
          </div>
          <h1>New order</h1>
        </div>
      </header>
      <form action={saveQuote} className="stack">
        {error && <p className="error">{error}</p>}
        <section className="glass panel">
          <div className="form-row">
            <label className="field grow">
              <span>Customer</span>
              <select name="customerId" required defaultValue={customer ?? ""}>
                <option value="">Choose a customer</option>
                {customers.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                    {option.priceListName ? ` · ${option.priceListName}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field tax-field">
              <span>Tax %</span>
              <input name="taxRatePercent" type="number" min="0" max="99" step="any" defaultValue="0" inputMode="decimal" />
            </label>
          </div>
        </section>
        <section className="glass panel">
          <h2 className="title">Items</h2>
          <OrderLinesEditor
            tracked={tracked}
            customerPrices={customerPrices}
            initialCustomer={customer ?? ""}
            products={products.map((product) => ({
              id: product.id,
              sku: product.sku,
              name: product.name,
              price: product.price,
              available: product.available,
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
            Save as quote
          </button>
          <Link href="/sales" className="btn btn-glass">
            Cancel
          </Link>
        </div>
        <p className="muted footnote">
          {tracked
            ? "A quote reserves no stock. Stock is reserved when you confirm the order."
            : "A quote commits to nothing. Confirm it when the customer says yes, then complete the order."}
        </p>
      </form>
    </>
  );
}
