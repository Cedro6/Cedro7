import type { ProductSummary } from "@bos/core";

/** Shared by New product and Edit product. Cost and stock fields only appear when they apply. */
export function ProductFields({ product, showCost, tracked }: { product?: ProductSummary; showCost: boolean; tracked: boolean }) {
  return (
    <>
      <label className="field">
        <span>Product name</span>
        <input name="name" required maxLength={200} defaultValue={product?.name ?? ""} autoFocus={!product} />
      </label>
      <div className="form-row">
        <label className="field">
          <span>Product code (SKU)</span>
          <input name="sku" required maxLength={60} defaultValue={product?.sku ?? ""} />
        </label>
        <label className="field">
          <span>Category</span>
          <input name="category" maxLength={100} defaultValue={product?.category ?? ""} />
        </label>
      </div>
      <label className="field">
        <span>Barcode</span>
        <input name="barcode" maxLength={64} inputMode="text" autoComplete="off" defaultValue={product?.barcode ?? ""} placeholder="Scan or type the number under the bars" />
      </label>
      <div className="form-row">
        <label className="field">
          <span>Price</span>
          <input name="price" type="number" min="0" step="0.01" inputMode="decimal" required defaultValue={product?.price ?? ""} />
        </label>
        {showCost && (
          <label className="field">
            <span>Cost</span>
            <input name="cost" type="number" min="0" step="0.01" inputMode="decimal" defaultValue={product?.cost ?? ""} />
          </label>
        )}
      </div>
      {tracked && (
        <div className="form-row">
          <label className="field">
            <span>Reorder when stock falls to</span>
            <input name="reorderPoint" type="number" min="0" step="1" inputMode="numeric" defaultValue={product?.reorderPoint ?? ""} />
          </label>
          <label className="field">
            <span>Shelf location</span>
            <input name="shelfLocation" maxLength={50} defaultValue={product?.shelfLocation ?? ""} />
          </label>
        </div>
      )}
    </>
  );
}
