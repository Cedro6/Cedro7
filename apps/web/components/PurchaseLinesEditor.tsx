"use client";

import { useState } from "react";

type ProductOption = { id: string; sku: string; name: string; cost: number; available: number; onOrder: number };
type Line = { key: number; productId: string; qty: string; unitCost: string };

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** The line items of a new purchase order. Posts repeated productId, qty and unitCost fields. */
export function PurchaseLinesEditor({
  products,
  initial,
}: {
  products: ProductOption[];
  initial: { productId: string; qty: number }[];
}) {
  const byId = new Map(products.map((product) => [product.id, product]));
  const start: Line[] = initial.length
    ? initial.map((line, index) => ({
        key: index + 1,
        productId: line.productId,
        qty: String(line.qty),
        unitCost: String(byId.get(line.productId)?.cost ?? ""),
      }))
    : [{ key: 1, productId: "", qty: "", unitCost: "" }];
  const [lines, setLines] = useState<Line[]>(start);
  const [nextKey, setNextKey] = useState(start.length + 1);
  const update = (key: number, patch: Partial<Line>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const total = lines.reduce((sum, line) => {
    const qty = Number(line.qty);
    const cost = Number(line.unitCost);
    return qty > 0 && cost >= 0 ? sum + Math.round(qty * cost * 100) / 100 : sum;
  }, 0);

  return (
    <div className="stack">
      {lines.map((line, index) => {
        const product = byId.get(line.productId);
        return (
          <div className="order-line" key={line.key}>
            <label className="field order-line-product">
              <span>{index === 0 ? "Product" : <span className="sr-only">Product</span>}</span>
              <select
                name="productId"
                required
                value={line.productId}
                onChange={(event) =>
                  update(line.key, {
                    productId: event.target.value,
                    unitCost: String(byId.get(event.target.value)?.cost ?? ""),
                  })
                }
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
              <span>{index === 0 ? "Cost each" : <span className="sr-only">Cost each</span>}</span>
              <input
                name="unitCost"
                type="number"
                min="0"
                step="any"
                required
                inputMode="decimal"
                value={line.unitCost}
                onChange={(event) => update(line.key, { unitCost: event.target.value })}
              />
            </label>
            <div className="order-line-info">
              {product ? (
                <span className="muted">
                  {product.available} available
                  {product.onOrder > 0 ? ` · ${product.onOrder} already on order` : ""}
                </span>
              ) : (
                <span className="muted">Stock appears here</span>
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
            setLines((current) => [...current, { key: nextKey, productId: "", qty: "", unitCost: "" }]);
            setNextKey(nextKey + 1);
          }}
        >
          Add another product
        </button>
        <div className="order-subtotal">
          <span className="muted">Order total</span>
          <span className="numeral numeral-md">{money.format(total)}</span>
        </div>
      </div>
    </div>
  );
}
