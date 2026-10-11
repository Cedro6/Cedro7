"use client";

import { useState } from "react";
import type { PickLine } from "@bos/core";

const qty = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

/**
 * A pick list to tick off while walking the shelves. Ticks live on this screen only;
 * the order changes when "Ship" is pressed, which is enabled once every line is ticked.
 */
export function PickList({ lines, children }: { lines: PickLine[]; children: React.ReactNode }) {
  const [picked, setPicked] = useState<boolean[]>(() => lines.map(() => false));
  const done = picked.filter(Boolean).length;
  const all = done === lines.length;
  return (
    <>
      <div className="pick-progress muted" aria-live="polite">
        {done} of {lines.length} picked
      </div>
      <div className="pick-list">
        {lines.map((line, index) => (
          <button
            type="button"
            key={`${line.sku}-${index}`}
            className={`pick-row ${picked[index] ? "is-picked" : ""}`}
            aria-pressed={picked[index]}
            onClick={() => setPicked((now) => now.map((value, i) => (i === index ? !value : value)))}
          >
            <span className="pick-check" aria-hidden="true">
              {picked[index] ? "✓" : ""}
            </span>
            <span className="pick-shelf mono">{line.shelf ?? "No shelf"}</span>
            <span className="pick-name">
              <span className="row-title">{line.name}</span>
              <span className="muted mono">{line.sku}</span>
            </span>
            <span className="pick-qty">
              <span className="numeral numeral-md">{qty(line.qty)}</span>
            </span>
          </button>
        ))}
      </div>
      <fieldset className="pick-actions plain-fieldset" disabled={!all}>
        {children}
        {!all && <span className="muted">Tick every line to ship.</span>}
      </fieldset>
    </>
  );
}
