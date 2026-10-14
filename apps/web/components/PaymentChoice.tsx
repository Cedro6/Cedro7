"use client";

import { useState } from "react";

/** The terms a sale can be on. "Paid in full" is the usual case: the money came in at the till. */
export const PAYMENT_CHOICES = [
  { value: "paid", label: "Paid in full" },
  { value: "receipt", label: "Due on receipt" },
  { value: "15", label: "Net 15" },
  { value: "30", label: "Net 30" },
  { value: "60", label: "Net 60" },
  { value: "custom", label: "Custom days" },
] as const;

/**
 * How this sale is being paid. Paid in full records the money as the invoice is raised and asks how
 * it was taken; the rest leave it owing, due today or in so many days.
 */
export function PaymentChoice({ methods, usualTerms, compact = false }: {
  methods: readonly string[];
  /** The customer's own terms, if they have any recorded, shown as a hint. */
  usualTerms?: string | null;
  compact?: boolean;
}) {
  const [choice, setChoice] = useState<string>("paid");
  return (
    <div className={compact ? "pay-choice pay-choice-compact" : "pay-choice"}>
      <label className="field">
        <span>Payment</span>
        <select name="paymentChoice" value={choice} onChange={(e) => setChoice(e.target.value)}>
          {PAYMENT_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>
      {choice === "paid" && (
        <label className="field">
          <span>How</span>
          <select name="paymentMethod" defaultValue="Cash">
            {methods.map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
      )}
      {choice === "paid" && !compact && (
        <label className="field">
          <span>Reference</span>
          <input name="paymentReference" maxLength={80} placeholder="Check no., last 4…" />
        </label>
      )}
      {choice === "custom" && (
        <label className="field tax-field">
          <span>Days</span>
          <input name="dueInDays" type="number" min="0" max="365" step="1" inputMode="numeric" defaultValue="30" required />
        </label>
      )}
      {usualTerms && choice !== "paid" && <p className="muted pay-hint">Their usual terms: {usualTerms}</p>}
    </div>
  );
}
