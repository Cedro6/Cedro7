import type { PurchaseOrderStatus } from "@bos/core";

const label: Record<PurchaseOrderStatus, string> = {
  draft: "Draft",
  pending_approval: "Needs approval",
  approved: "Approved",
  sent: "Sent to supplier",
  partially_received: "Partially received",
  received: "Received",
  cancelled: "Cancelled",
};

const tone: Record<PurchaseOrderStatus, string> = {
  draft: "",
  pending_approval: "badge-warn",
  approved: "badge-info",
  sent: "badge-info",
  partially_received: "badge-warn",
  received: "badge-ok",
  cancelled: "badge-muted",
};

export function PoStatusBadge({ status, large = false }: { status: PurchaseOrderStatus; large?: boolean }) {
  return <span className={`badge ${tone[status]} ${large ? "badge-large" : ""}`}>{label[status]}</span>;
}
