import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getCompanyProfile, getPurchaseOrder, getSupplier } from "@bos/core";
import { PaperBrand } from "../../../../../components/PaperBrand";
import { PrintButton } from "../../../../../components/PrintButton";
import { formatMoney, formatQty } from "../../../../../lib/format";
import { zone } from "../../../../../lib/locale";
import { requireSession } from "../../../../../lib/session";

const date = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The purchase order as a document to print or save as a PDF and send to the supplier. */
export default async function PurchaseOrderPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "purchase_order.read")) notFound();
  const { id } = await params;
  const order = await getPurchaseOrder(ctx, id);
  if (!order) notFound();
  const [company, supplier] = await Promise.all([getCompanyProfile(ctx), getSupplier(ctx, order.supplierId)]);
  const showCost = order.total !== null;
  const draft = order.status === "draft" || order.status === "pending_approval";
  return (
    <>
      <header className="page-head no-print">
        <div>
          <div className="eyebrow">
            <Link href="/purchasing">Purchasing</Link> / <Link href={`/purchasing/${id}`}>{order.number}</Link>
          </div>
          <h1>Purchase order</h1>
        </div>
        <PrintButton />
      </header>
      {draft && <p className="notice no-print">This order has not been approved yet. The printed copy is marked as a draft.</p>}
      {order.status === "cancelled" && <p className="error no-print">This order was cancelled. The printed copy says so.</p>}
      <section className="paper">
        <div className="paper-head">
          <PaperBrand company={company} />
          <div className="paper-title">
            Purchase order{draft ? " (draft)" : order.status === "cancelled" ? " (cancelled)" : ""}
            <div className="paper-muted mono">{order.number}</div>
          </div>
        </div>
        <div className="paper-meta">
          <div>
            <div className="paper-label">To</div>
            <div className="paper-strong">{order.supplierName}</div>
            {supplier?.address && <div className="address">{supplier.address}</div>}
            {supplier && (supplier.email || supplier.phone) && <div>{[supplier.email, supplier.phone].filter(Boolean).join(" · ")}</div>}
            {supplier?.paymentTerms && <div className="paper-muted">Terms: {supplier.paymentTerms}</div>}
          </div>
          <div>
            <div className="paper-label">Deliver to</div>
            <div className="paper-strong">{company.name}</div>
            {company.address && <div className="address">{company.address}</div>}
          </div>
          <div>
            <div className="paper-label">Date</div>
            <div>{new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: zone() }).format(order.approvedAt ?? order.createdAt)}</div>
            <div className="paper-label">Needed by</div>
            <div>{order.expectedOn ? date(order.expectedOn) : "As soon as possible"}</div>
          </div>
        </div>
        <div className="table-wrap">
          <table className="paper-table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Quantity</th>
                {showCost && <th className="num">Unit cost</th>}
                {showCost && <th className="num">Amount</th>}
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    {line.name}
                    <div className="paper-muted mono">{line.sku}</div>
                  </td>
                  <td className="num">{formatQty(line.qty)}</td>
                  {showCost && <td className="num">{formatMoney(line.unitCost ?? 0)}</td>}
                  {showCost && <td className="num">{formatMoney(line.amount ?? 0)}</td>}
                </tr>
              ))}
            </tbody>
            {showCost && (
              <tfoot>
                <tr>
                  <td colSpan={3} className="num paper-strong">Total</td>
                  <td className="num paper-strong">{formatMoney(order.total ?? 0)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        {order.notes && <p className="paper-note">{order.notes}</p>}
        <p className="paper-note">Please confirm this order and the delivery date. Quote {order.number} on your delivery note and invoice.</p>
      </section>
    </>
  );
}
