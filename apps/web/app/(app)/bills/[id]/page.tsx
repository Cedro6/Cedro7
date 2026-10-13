import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { can, getExpense, today } from "@bos/core";
import { formatMoney } from "../../../../lib/format";
import { requireSession } from "../../../../lib/session";
import { markPaid, voidBill } from "../actions";
import { billDate, BillStatus } from "../../../../components/BillStatus";

export default async function BillPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "expense.read")) redirect("/");
  const bill = await getExpense(ctx, (await params).id);
  if (!bill) notFound();
  const { error, notice } = await searchParams;
  const write = can(ctx, "expense.write") && !bill.voided;
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow"><Link href="/bills">Bills and expenses</Link></div>
          <h1>{bill.description}</h1>
        </div>
        <BillStatus bill={bill} />
      </header>
      {error && <p className="error">{error}</p>}
      {notice && !error && <p className="notice">{notice}</p>}
      <section className="glass panel">
        <div className="numeral">{formatMoney(bill.amount)}</div>
        <dl className="bill-facts">
          <div><dt>Category</dt><dd>{bill.category}</dd></div>
          <div><dt>Date</dt><dd>{billDate(bill.incurredOn)}</dd></div>
          {bill.supplierName && <div><dt>Supplier</dt><dd>{bill.supplierName}</dd></div>}
          {bill.purchaseOrderId && <div><dt>Purchase order</dt><dd><Link href={`/purchasing/${bill.purchaseOrderId}`} className="row-link">{bill.purchaseOrderNumber}</Link></dd></div>}
          {bill.reference && <div><dt>Their invoice number</dt><dd>{bill.reference}</dd></div>}
          {bill.dueOn && <div><dt>Due</dt><dd>{billDate(bill.dueOn)}</dd></div>}
          {bill.paidOn && <div><dt>Paid</dt><dd>{billDate(bill.paidOn)}{bill.paidMethod ? ` by ${bill.paidMethod}` : ""}</dd></div>}
          {bill.voided && <div><dt>Voided because</dt><dd>{bill.voidReason}</dd></div>}
        </dl>
      </section>
      {write && !bill.paidOn && (
        <section className="glass panel form-panel">
          <h2 className="title">Mark as paid</h2>
          <form action={markPaid} className="form-row bill-inline">
            <input type="hidden" name="id" value={bill.id} />
            <label className="field grow"><span>Paid on</span><input name="paidOn" type="date" required defaultValue={today()} /></label>
            <label className="field grow"><span>Paid by (optional)</span><input name="method" maxLength={40} placeholder="Card, check, bank transfer" /></label>
            <button type="submit" className="btn btn-primary">Mark as paid</button>
          </form>
        </section>
      )}
      {write && (
        <section className="glass panel form-panel">
          <h2 className="title">Entered by mistake?</h2>
          <p className="muted">Voiding keeps the record but stops it counting in what you owe, what you paid and profit.</p>
          <form action={voidBill} className="form-row bill-inline">
            <input type="hidden" name="id" value={bill.id} />
            <label className="field grow"><span>Reason</span><input name="reason" required maxLength={200} /></label>
            <button type="submit" className="btn btn-glass">Void</button>
          </form>
        </section>
      )}
    </>
  );
}
