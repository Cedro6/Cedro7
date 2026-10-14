import Link from "next/link";
import { notFound } from "next/navigation";
import { can, cashReport, CASH_REPORT_THRESHOLD, getCompanyProfile, getDeal, getDealerSettings } from "@bos/core";
import { BackToDeal } from "../../../../../components/BackToDeal";
import { PrintButton } from "../../../../../components/PrintButton";
import { formatMoney } from "../../../../../lib/format";
import { requireSession } from "../../../../../lib/session";

/**
 * Everything IRS Form 8300 asks for, gathered from the deal, to copy into the IRS's own form. The
 * buyer's taxpayer number and the dealership's EIN are left blank on purpose: neither is stored here.
 */
export default async function Form8300Page({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "vehicle.read")) notFound();
  const { id } = await params;
  const deal = await getDeal(ctx, id);
  if (!deal) notFound();
  const cash = cashReport(deal.payments);
  const [company, dealer] = await Promise.all([getCompanyProfile(ctx), getDealerSettings(ctx)]);
  const [last, ...rest] = deal.buyerName.trim().split(/\s+/).reverse();
  const first = rest.reverse().join(" ");
  const Row = ({ label, value, blank }: { label: string; value?: string | null; blank?: string }) => (
    <tr><th>{label}</th><td>{value ? value : <span className="paper-muted">{blank ?? "Fill in by hand"}</span>}</td></tr>
  );
  return (
    <>
      <header className="page-head no-print">
        <div>
          <div className="eyebrow"><Link href="/deals">Deals</Link> / <Link href={`/deals/${id}`}>{deal.number}</Link></div>
          <h1>Form 8300 worksheet</h1>
        </div>
        <BackToDeal id={id} number={deal.number} />
        <PrintButton />
      </header>
      {!cash.required && <p className="notice no-print">This deal has not passed {formatMoney(CASH_REPORT_THRESHOLD)} in cash, so Form 8300 is not required for it yet.</p>}
      <p className="muted no-print">
        This is not the IRS form. It gathers what Form 8300 asks for so it can be copied into the IRS&apos;s form, filed through BSA E-Filing or on paper.
        Check it against the current form&apos;s instructions on irs.gov, and with your accountant.
      </p>
      <section className="paper w8300">
        <div className="paper-head">
          <div className="paper-strong">Form 8300 worksheet · {deal.number}</div>
          <div className="paper-title">
            {cash.dueOn ? <>File by {cash.dueOn}</> : "Not yet required"}
            <div className="paper-muted">{deal.form8300FiledOn ? `Recorded as filed ${deal.form8300FiledOn}` : "Not recorded as filed"}</div>
          </div>
        </div>
        <h3 className="paper-label">The buyer (the person the cash came from)</h3>
        <table className="paper-table"><tbody>
          <Row label="Last name" value={last} />
          <Row label="First name and middle" value={first || null} />
          <Row label="Taxpayer ID number (SSN or ITIN)" blank="Ask the buyer and write it on the form. It is not kept on the site." />
          <Row label="Address" value={[deal.buyerAddress, [deal.buyerCity, deal.buyerState, deal.buyerZip].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null} />
          <Row label="Date of birth" value={deal.buyerDob} />
          <Row label="Occupation, profession or business" value={deal.buyerOccupation} />
          <Row label="ID used to verify identity" value={deal.buyerDl ? `Driver's licence ${deal.buyerDl}${deal.buyerState ? `, issued by ${deal.buyerState}` : ""}` : null} />
          {deal.coBuyerName && <Row label="Co-buyer (report each person who paid cash)" value={`${deal.coBuyerName}: their details are not on the deal; collect them separately`} />}
        </tbody></table>

        <h3 className="paper-label">The transaction</h3>
        <table className="paper-table"><tbody>
          <Row label="Date the cash passed $10,000" value={cash.crossedOn} blank="Not passed yet" />
          <Row label="Total cash received" value={formatMoney(cash.total)} />
          <Row label="Received in more than one payment" value={cash.counted.length > 1 ? "Yes" : "No"} />
          <Row label="Total price, if different from the cash" value={Math.abs(deal.total - cash.total) > 0.005 ? formatMoney(deal.total) : null} blank="Same as the cash" />
          <Row label="Type of transaction" value="Personal property purchased (a motor vehicle)" />
          <Row label="Description of the property" value={`${deal.vehicleName || "Vehicle"}, VIN ${deal.vin ?? "none recorded"}, stock ${deal.stockNumber}`} />
        </tbody></table>
        <div className="table-wrap">
          <table className="paper-table">
            <thead><tr><th>Date</th><th>How</th><th>Issuer and serial number</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {cash.counted.map((p) => (
                <tr key={p.id}><td>{p.paidOn}</td><td>{p.method}</td><td>{p.method === "Cash" ? "—" : p.reference ?? <span className="paper-muted">Write the issuer and serial number</span>}</td><td className="num">{formatMoney(p.amount)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="paper-label">The business that received the cash</h3>
        <table className="paper-table"><tbody>
          <Row label="Name" value={company.name} />
          <Row label="Employer ID number (EIN)" value={company.taxNumber} />
          <Row label="Address" value={company.address?.replace(/\n/g, ", ") ?? null} />
          <Row label="Nature of business" value={`Used motor vehicle dealer${dealer.licence ? `, Florida licence ${dealer.licence}` : ""}`} />
          <Row label="Contact name, title and phone" value={company.phone ? `Phone ${company.phone}` : null} />
        </tbody></table>
        <p className="paper-muted">The buyer must also be sent a written statement that the report was filed, by January 31 of the next year.</p>
      </section>
    </>
  );
}
