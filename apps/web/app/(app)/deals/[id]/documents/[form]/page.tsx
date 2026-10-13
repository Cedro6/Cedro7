import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getDeal } from "@bos/core";
import { BackToDeal } from "../../../../../../components/BackToDeal";
import { FLORIDA_FORMS, isFloridaForm } from "../../../../../../lib/florida-forms";
import { requireSession } from "../../../../../../lib/session";

/**
 * One of the state forms, shown inside the site with a way back to the deal. The filled PDF itself
 * comes from the forms route; this page frames it and offers it to download or open full screen.
 */
export default async function DealDocumentPage({ params }: { params: Promise<{ id: string; form: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "vehicle.read")) notFound();
  const { id, form } = await params;
  if (!isFloridaForm(form)) notFound();
  const deal = await getDeal(ctx, id);
  if (!deal) notFound();
  const pdf = `/deals/${id}/forms/${form}`;
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow"><Link href="/deals">Deals</Link> / <Link href={`/deals/${id}`}>{deal.number}</Link></div>
          <h1>{FLORIDA_FORMS[form].title}</h1>
        </div>
        <BackToDeal id={id} number={deal.number} />
        <a href={`${pdf}?download=1`} className="btn btn-glass">Download PDF</a>
        <a href={pdf} className="btn btn-primary" target="_blank" rel="noreferrer">Open to print</a>
      </header>
      <p className="muted">{FLORIDA_FORMS[form].about} Check every field before the buyer signs.</p>
      <section className="glass panel pdf-panel">
        <iframe src={pdf} title={FLORIDA_FORMS[form].title} className="pdf-frame" />
        <p className="muted pdf-fallback">If the form doesn&apos;t show here (some phones can&apos;t display a PDF inside a page), use Open to print or Download PDF.</p>
      </section>
    </>
  );
}
