import { PDFDocument } from "pdf-lib";
import { can, getCompanyProfile, getDeal, getDealerSettings } from "@bos/core";
import { fillFloridaForm, formsForDeal } from "../../../../../../lib/florida-forms";
import { todayHere } from "../../../../../../lib/locale";
import { requireSession } from "../../../../../../lib/session";

/** Every state form this deal needs, filled and joined into one PDF, so the lot prints them in one go. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { ctx } = await requireSession();
  const { id } = await params;
  if (!can(ctx, "vehicle.read")) return new Response("Not found", { status: 404 });
  const deal = await getDeal(ctx, id);
  if (!deal) return new Response("Not found", { status: 404 });
  const [company, dealer] = await Promise.all([getCompanyProfile(ctx), getDealerSettings(ctx)]);
  const source = { deal, company, dealer, today: todayHere() };
  try {
    const all = await PDFDocument.create();
    for (const form of formsForDeal(deal)) {
      const one = await PDFDocument.load(await fillFloridaForm(form, source), { ignoreEncryption: true });
      const pages = await all.copyPages(one, one.getPageIndices());
      for (const page of pages) all.addPage(page);
    }
    all.setTitle(`${deal.number} state forms`);
    const bytes = await all.save();
    const how = new URL(request.url).searchParams.has("download") ? "attachment" : "inline";
    return new Response(Buffer.from(bytes), {
      headers: { "content-type": "application/pdf", "content-disposition": `${how}; filename="${deal.number}-state-forms.pdf"`, "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("florida forms: could not be joined", error);
    return new Response("The forms could not be filled. The state's forms may have changed; tell support.", { status: 500 });
  }
}
