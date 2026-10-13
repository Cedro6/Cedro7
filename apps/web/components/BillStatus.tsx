import type { Expense } from "@bos/core";

export const billDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function BillStatus({ bill }: { bill: Expense }) {
  if (bill.voided) return <span className="badge badge-muted">Voided</span>;
  if (bill.paidOn) return <span className="badge badge-ok">Paid {billDate(bill.paidOn)}</span>;
  if (bill.paid > 0 && bill.daysLate === 0) return <span className="badge badge-info">Part paid{bill.dueOn ? ` · due ${billDate(bill.dueOn)}` : ""}</span>;
  if (bill.daysLate > 0) return <span className="badge badge-bad">{bill.daysLate} {bill.daysLate === 1 ? "day" : "days"} late</span>;
  if (bill.dueOn) return <span className="badge badge-warn">Due {billDate(bill.dueOn)}</span>;
  return <span className="badge badge-warn">Not paid</span>;
}
