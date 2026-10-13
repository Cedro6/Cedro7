import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getCompanyProfile, getPackingSlip } from "@bos/core";
import { PaperBrand } from "../../../../../../components/PaperBrand";
import { PrintButton } from "../../../../../../components/PrintButton";
import { formatQty } from "../../../../../../lib/format";
import { requireSession } from "../../../../../../lib/session";
import { zone } from "../../../../../../lib/locale";

const day = { format: (d: Date | number) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: zone() }).format(d) };

export default async function PackingSlipPage({ params }: { params: Promise<{ id: string; shipment: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "sales_order.read")) notFound();
  const { id, shipment } = await params;
  const slip = await getPackingSlip(ctx, shipment);
  if (!slip || slip.orderId !== id) notFound();
  const company = await getCompanyProfile(ctx);
  const units = slip.lines.reduce((sum, line) => sum + line.qty, 0);
  return (
    <>
      <header className="page-head no-print">
        <div>
          <div className="eyebrow">
            <Link href="/sales">Sales</Link> / <Link href={`/sales/${id}`}>{slip.orderNumber}</Link>
          </div>
          <h1>Packing slip</h1>
        </div>
        <PrintButton />
      </header>
      <section className="paper">
        <div className="paper-head">
          <PaperBrand company={company} />
          <div className="paper-title">
            Packing slip
            <div className="paper-muted mono">{slip.shipmentNumber}</div>
          </div>
        </div>
        <div className="paper-meta">
          <div>
            <div className="paper-label">Ship to</div>
            <div className="paper-strong">{slip.customerName}</div>
            {slip.shipTo && <div className="address">{slip.shipTo}</div>}
          </div>
          <div>
            <div className="paper-label">Shipped</div>
            <div>{day.format(slip.shippedAt)}</div>
            <div className="paper-label">Order</div>
            <div className="mono">{slip.orderNumber}</div>
          </div>
        </div>
        <div className="table-wrap">
          <table className="paper-table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Ordered</th>
                <th className="num">In this box</th>
              </tr>
            </thead>
            <tbody>
              {slip.lines.map((line) => (
                <tr key={line.sku}>
                  <td>
                    {line.name}
                    <div className="paper-muted mono">{line.sku}</div>
                  </td>
                  <td className="num">{formatQty(line.ordered)}</td>
                  <td className="num">{formatQty(line.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="paper-note">
          {formatQty(units)} {units === 1 ? "unit" : "units"} in this shipment. Please check the contents against this list and tell us about anything missing or damaged.
        </p>
      </section>
    </>
  );
}
