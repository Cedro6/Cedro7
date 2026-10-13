import { can, getCompanyProfile, getDeal, getDealerSettings } from "@bos/core";
import { fillFloridaForm, isFloridaForm } from "../../../../../../lib/florida-forms";
import { todayHere } from "../../../../../../lib/locale";
import { requireSession } from "../../../../../../lib/session";

/** One of Florida's title forms, filled from the deal, as a PDF to print and sign. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; form: string }> }) {
  const { ctx } = await requireSession();
  const { id, form } = await params;
  if (!can(ctx, "vehicle.read") || !isFloridaForm(form)) return new Response("Not found", { status: 404 });
  const deal = await getDeal(ctx, id);
  if (!deal) return new Response("Not found", { status: 404 });
  const [company, dealer] = await Promise.all([getCompanyProfile(ctx), getDealerSettings(ctx)]);
  try {
    const bytes = await fillFloridaForm(form, { deal, company, dealer, today: todayHere() });
    return new Response(Buffer.from(bytes), {
      headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${deal.number}-HSMV-${form}.pdf"`, "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("florida form failed", form, error);
    return new Response("The form could not be filled. The state's form may have changed; tell support which form it was.", { status: 500 });
  }
}
