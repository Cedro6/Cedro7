import Link from "next/link";
import { notFound } from "next/navigation";
import { can, customerStatement } from "@bos/core";
import { InvoiceBadge } from "../../../../../components/InvoiceBadge";
import { PrintButton } from "../../../../../components/PrintButton";
import { formatMoney } from "../../../../../lib/format";
import { requireSession } from "../../../../../lib/session";

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });

export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx, membership } = await requireSession();
  if (!can(ctx, "sales_order.read")) notFound();
  const { id } = await params;
  const statement = await customerStatement(ctx, id);
  if (!statement) notFound();
  return (
    <>
      <header className="page-head no-print">
        <div>
          <div className="eyebrow">
            <Link href="/customers">Customers</Link> / <Link href={`/customers/${id}`}>{statement.customerName}</Link>
          </div>
          <h1>Statement</h1>
        </div>
        <PrintButton />
      </header>
      <section className="paper">
        <div className="paper-head">
          <div className="paper-brand">
            <div>
              <div className="paper-company">{membership.orgName}</div>
            </div>
          </div>
          <div className="paper-title">
            Statement
            <div className="paper-muted">{day.format(new Date())}</div>
          </div>
        </div>
        <div className="paper-meta">
          <div>
            <div className="paper-label">For</div>
            <div className="paper-strong">{statement.customerName}</div>
          </div>
          <div>
            <div className="paper-label">Owed</div>
            <div className="paper-strong">{formatMoney(statement.owed)}</div>
          </div>
          <div>
            <div className="paper-label">Of which overdue</div>
            <div>{formatMoney(statement.overdue)}</div>
          </div>
        </div>
        {statement.invoices.length === 0 ? (
          <p className="paper-note">No invoices yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="paper-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Issued</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th className="num">Amount</th>
                  <th className="num">Paid or credited</th>
                  <th className="num">Owed</th>
                </tr>
              </thead>
              <tbody>
                {statement.invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="mono">
                      <Link href={`/invoices/${invoice.id}`}>{invoice.number}</Link>
                    </td>
                    <td>{day.format(invoice.issuedAt)}</td>
                    <td>{day.format(invoice.dueAt)}</td>
                    <td>
                      <InvoiceBadge state={invoice.state} />
                    </td>
                    <td className="num">{formatMoney(invoice.amount)}</td>
                    <td className="num">{formatMoney(invoice.paid + invoice.credited)}</td>
                    <td className="num">{formatMoney(invoice.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="paper-totals">
          <div className="paper-total">
            <span>Total owed</span>
            <span>{formatMoney(statement.owed)}</span>
          </div>
          {statement.credit > 0 && (
            <div>
              <span>Credit on account, not yet used</span>
              <span>{formatMoney(statement.credit)}</span>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
