import Link from "next/link";
import { redirect } from "next/navigation";
import { can, EXPENSE_FILTERS, expenseSummary, listExpenses, type ExpenseFilter } from "@bos/core";
import { billDate, BillStatus } from "../../../components/BillStatus";
import { formatMoney } from "../../../lib/format";
import { requireSession } from "../../../lib/session";

const whole = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const LABEL: Record<ExpenseFilter, string> = { unpaid: "To pay", paid: "Paid", all: "All", voided: "Voided" };
export default async function BillsPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "expense.read")) redirect("/");
  const asked = (await searchParams).show;
  const show: ExpenseFilter = (EXPENSE_FILTERS as readonly string[]).includes(asked ?? "") ? (asked as ExpenseFilter) : "unpaid";
  const [bills, sum] = await Promise.all([listExpenses(ctx, show), expenseSummary(ctx)]);
  const total = bills.reduce((n, b) => n + b.amount, 0);
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            {bills.length} {bills.length === 1 ? "entry" : "entries"} · {formatMoney(total)}
          </div>
          <h1>Bills and expenses</h1>
        </div>
        <div className="segmented" role="group" aria-label="Show">
          {EXPENSE_FILTERS.map((f) => (
            <Link key={f} href={f === "unpaid" ? "/bills" : `/bills?show=${f}`} aria-current={f === show ? "true" : undefined}>
              {LABEL[f]}
            </Link>
          ))}
        </div>
        {can(ctx, "expense.write") && (
          <Link href="/bills/new" className="btn btn-primary">
            New bill or expense
          </Link>
        )}
      </header>

      <div className="tiles">
        <div className="glass panel tile">
          <h2 className="label">You owe</h2>
          <div className="numeral">{whole(sum.owed)}</div>
          <div className="muted">{sum.unpaid} unpaid {sum.unpaid === 1 ? "bill" : "bills"}</div>
        </div>
        <div className="glass panel tile">
          <h2 className="label">Overdue</h2>
          <div className="numeral">{whole(sum.overdue)}</div>
          <div className="muted">{sum.overdueCount === 0 ? "Nothing late" : `${sum.overdueCount} ${sum.overdueCount === 1 ? "bill" : "bills"} past due`}</div>
        </div>
        <div className="glass panel tile">
          <h2 className="label">Due in the next 7 days</h2>
          <div className="numeral">{whole(sum.dueSoon)}</div>
          <div className="muted">Today included</div>
        </div>
        <div className="glass panel tile">
          <h2 className="label">Paid this month</h2>
          <div className="numeral">{whole(sum.paidThisMonth)}</div>
          <div className="muted">By payment date</div>
        </div>
      </div>

      {bills.length === 0 ? (
        <section className="glass panel empty">
          <div className="empty-title">{show === "unpaid" ? "Nothing to pay" : "Nothing here yet"}</div>
          <p>Record a supplier bill when it arrives, or an expense you already paid, and it shows up here and in the profit report.</p>
        </section>
      ) : (
        <section className="glass panel">
          <div className="table-wrap">
            <table className="compact">
              <thead>
                <tr><th scope="col">Date</th><th scope="col">For</th><th scope="col">Category</th><th scope="col">Status</th><th scope="col" className="num">Amount</th></tr>
              </thead>
              <tbody>
                {bills.map((b) => (
                  <tr key={b.id}>
                    <td>{billDate(b.incurredOn)}</td>
                    <td>
                      <Link href={`/bills/${b.id}`} className="row-link">{b.description}</Link>
                      {b.supplierName && <div className="muted">{b.supplierName}</div>}
                    </td>
                    <td>{b.category}</td>
                    <td><BillStatus bill={b} /></td>
                    <td className="num">{formatMoney(b.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
