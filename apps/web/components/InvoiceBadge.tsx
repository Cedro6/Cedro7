import type { InvoiceState } from "@bos/core";

const label: Record<InvoiceState, string> = {
  unpaid: "Unpaid",
  part_paid: "Part paid",
  paid: "Paid",
  overdue: "Overdue",
  void: "Void",
};
const tone: Record<InvoiceState, string> = {
  unpaid: "badge-warn",
  part_paid: "badge-info",
  paid: "badge-ok",
  overdue: "badge-bad",
  void: "badge-muted",
};

/** Colour never carries the meaning alone: the state is always written out. */
export function InvoiceBadge({ state, large = false }: { state: InvoiceState; large?: boolean }) {
  return <span className={`badge ${tone[state]} ${large ? "badge-large" : ""}`}>{label[state]}</span>;
}
