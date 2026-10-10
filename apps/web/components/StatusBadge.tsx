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

/** `tracked` is whether the business tracks stock: without it a finished order is "Completed", not "Shipped". */
export function StatusBadge({
  status,
  large = false,
  tracked = true,
}: {
  status: OrderStatus;
  large?: boolean;
  tracked?: boolean;
}) {
  const text = tracked ? label[status] : status === "shipped" ? "Completed" : status === "partially_shipped" ? "Part completed" : label[status];
  return <span className={`badge ${tone[status]} ${large ? "badge-large" : ""}`}>{text}</span>;
}
