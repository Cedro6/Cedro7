import Link from "next/link";
import { redirect } from "next/navigation";
import { can, listInvoices, type InvoiceState } from "@bos/core";
import { InvoiceBadge } from "../../../components/InvoiceBadge";
import { formatMoney } from "../../../lib/format";
import { requireSession } from "../../../lib/session";
import { zone } from "../../../lib/locale";

const filters: { key: string; label: string; state?: InvoiceState | "open" }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Unpaid", state: "open" },
  { key: "overdue", label: "Overdue", state: "overdue" },
  { key: "paid", label: "Paid", state: "paid" },
];

const day = { format: (d: Date | number) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: zone() }).format(d) };

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "sales_order.read")) redirect("/");
  const { show = "all" } = await searchParams;
  const active = filters.find((filter) => filter.key === show) ?? filters[0]!;
  const invoices = await listInvoices(ctx, { state: active.state });
  const owed = invoices.reduce((sum, invoice) => sum + invoice.balance, 0);
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            {invoices.length} {invoices.length === 1 ? "invoice" : "invoices"} · {formatMoney(owed)} still owed
          </div>
          <h1>Invoices</h1>
        </div>
        <div className="segmented" role="group" aria-label="Filter">
          {filters.map((filter) => (
            <Link
              key={filter.key}
              href={filter.key === "all" ? "/invoices" : `/invoices?show=${filter.key}`}
              aria-current={filter.key === active.key ? "true" : undefined}
            >
              {filter.label}
            </Link>
          ))}
        </div>
        {can(ctx, "invoice.write") && (
          <Link href="/invoices/new" className="btn btn-primary">
            New invoice
          </Link>
        )}
      </header>
      <section className="glass panel">
        {invoices.length === 0 ? (
          <div className="empty">
            <div className="empty-title">{active.key === "all" ? "No invoices yet" : "Nothing here"}</div>
            <p>
              {active.key === "all"
                ? "An invoice is raised each time an order ships or is completed. You can also write one by hand."
                : "No invoice matches this filter."}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Customer</th>
                  <th>Order</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th className="num">Amount</th>
                  <th className="num">Still owed</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>
                      <Link href={`/invoices/${invoice.id}`} className="row-link mono">
                        {invoice.number}
                      </Link>
                      {invoice.kind === "deposit" && <div className="muted">Deposit</div>}
                    </td>
                    <td>{invoice.customerName}</td>
                    <td>
                      {invoice.orderId ? (
                        <Link href={`/sales/${invoice.orderId}`} className="mono">
                          {invoice.orderNumber}
                        </Link>
                      ) : (
                        <span className="muted">None</span>
                      )}
                    </td>
                    <td>
                      {day.format(invoice.dueAt)}
                      <div className="muted">issued {day.format(invoice.issuedAt)}</div>
                    </td>
                    <td>
                      <InvoiceBadge state={invoice.state} />
                    </td>
                    <td className="num">{formatMoney(invoice.amount)}</td>
                    <td className="num strong">{invoice.balance > 0 ? formatMoney(invoice.balance) : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
