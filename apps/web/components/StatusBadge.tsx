import type { OrderStatus } from "@bos/core";

const label: Record<OrderStatus, string> = {
  quote: "Quote",
  confirmed: "Confirmed",
  partially_shipped: "Partially shipped",
  shipped: "Shipped",
  cancelled: "Cancelled",
};

const tone: Record<OrderStatus, string> = {
  quote: "",
  confirmed: "badge-info",
  partially_shipped: "badge-warn",
  shipped: "badge-ok",
  cancelled: "badge-muted",
};

export function StatusBadge({ status, large = false }: { status: OrderStatus; large?: boolean }) {
  return <span className={`badge ${tone[status]} ${large ? "badge-large" : ""}`}>{label[status]}</span>;
}
