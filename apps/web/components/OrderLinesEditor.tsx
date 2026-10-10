"use client";

import { useEffect, useRef, useState } from "react";

type ProductOption = { id: string; sku: string; name: string; price: number; available: number };
type Line = { key: number; productId: string; qty: string; discount: string };

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** The line items of a new order. Posts repeated productId and qty fields with the surrounding form. */
export function OrderLinesEditor({
  products,
  tracked,
  customerPrices,
  initialCustomer,
}: {
  products: ProductOption[];
  /** Whether the business tracks stock. Without it nothing about availability is shown. */
  tracked: boolean;
  /** Prices for customers on a price list: customer id, then product id. Everyone else pays the product's price. */
  customerPrices: Record<string, Record<string, number>>;
  initialCustomer: string;
}) {
  const [lines, setLines] = useState<Line[]>([{ key: 1, productId: "", qty: "", discount: "" }]);
  const [customer, setCustomer] = useState(initialCustomer);
  const root = useRef<HTMLDivElement>(null);
  // The customer is chosen elsewhere in the same form; follow it so prices match what will be saved.
  useEffect(() => {
    const select = root.current?.closest("form")?.querySelector<HTMLSelectElement>('select[name="customerId"]');
    if (!select) return;
    const onChange = () => setCustomer(select.value);
    onChange();
    select.addEventListener("change", onChange);
    return () => select.removeEventListener("change", onChange);
  }, []);
  const priceOf = (product: ProductOption) => customerPrices[customer]?.[product.id] ?? product.price;
  const netOf = (product: ProductOption, line: Line) => {
    const off = Math.min(100, Math.max(0, Number(line.discount) || 0));
    return Math.round(priceOf(product) * (100 - off)) / 100;
  };
  const [nextKey, setNextKey] = useState(2);
  const byId = new Map(products.map((product) => [product.id, product]));
  const update = (key: number, patch: Partial<Line>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const subtotal = lines.reduce((sum, line) => {
    const product = byId.get(line.productId);
    const qty = Number(line.qty);
    return product && qty > 0 ? sum + Math.round(qty * netOf(product, line) * 100) / 100 : sum;
  }, 0);

  return (
    <div className="stack" ref={root}>
      {lines.map((line, index) => {
        const product = byId.get(line.productId);
        const qty = Number(line.qty);
        const short = tracked && product && qty > product.available;
        return (
          <div className="order-line" key={line.key}>
            <label className="field order-line-product">
              <span>{index === 0 ? "Product" : <span className="sr-only">Product</span>}</span>
              <select
                name="productId"
                required
                value={line.productId}
                onChange={(event) => update(line.key, { productId: event.target.value })}
              >
                <option value="">Choose a product</option>
                {products.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.sku} · {option.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field order-line-qty">
              <span>{index === 0 ? "Quantity" : <span className="sr-only">Quantity</span>}</span>
              <input
                name="qty"
                type="number"
                min="0.0001"
                step="any"
                required
                inputMode="decimal"
                value={line.qty}
                onChange={(event) => update(line.key, { qty: event.target.value })}
              />
            </label>
            <label className="field order-line-qty">
              <span>{index === 0 ? "Discount %" : <span className="sr-only">Discount %</span>}</span>
              <input
                name="discountPercent"
                type="number"
                min="0"
                max="100"
                step="any"
                inputMode="decimal"
                placeholder="0"
                value={line.discount}
                onChange={(event) => update(line.key, { discount: event.target.value })}
              />
            </label>
            <div className="order-line-info">
              {product ? (
                <>
                  <span>
                    {money.format(netOf(product, line))} each
                    {netOf(product, line) !== product.price && (
                      <>
                        {" "}
                        <s className="muted">{money.format(product.price)}</s>
                      </>
                    )}
                    {qty > 0 ? ` · ${money.format(Math.round(qty * netOf(product, line) * 100) / 100)}` : ""}
                  </span>
                  {tracked && (
                    <span className={short ? "warn-text" : "muted"}>
                      {short
                        ? `Only ${product.available} available; the rest will be backordered`
                        : `${product.available} available`}
                    </span>
                  )}
                </>
              ) : (
                <span className="muted">{tracked ? "Price and stock appear here" : "The price appears here"}</span>
              )}
            </div>
            <button
              type="button"
              className="btn btn-glass btn-small"
              disabled={lines.length === 1}
              onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}
              aria-label={`Remove line ${index + 1}`}
            >
              Remove
            </button>
          </div>
        );
      })}
      <div className="order-lines-foot">
        <button
          type="button"
          className="btn btn-glass btn-small"
          onClick={() => {
            setLines((current) => [...current, { key: nextKey, productId: "", qty: "", discount: "" }]);
            setNextKey(nextKey + 1);
          }}
        >
          Add another product
        </button>
        <div className="order-subtotal">
          <span className="muted">Subtotal before tax</span>
          <span className="numeral numeral-md">{money.format(subtotal)}</span>
        </div>
      </div>
    </div>
  );
}
