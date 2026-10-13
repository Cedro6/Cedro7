import { importTemplate, isImportKind } from "@bos/core";
import { requireSession } from "../../../../lib/session";

/** A blank spreadsheet with the right headings and one example row. */
export async function GET(request: Request) {
  await requireSession();
  const kind = new URL(request.url).searchParams.get("kind");
  if (!isImportKind(kind)) return new Response("Unknown template", { status: 400 });
  return new Response(String.fromCharCode(0xfeff) + importTemplate(kind), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${kind}-template.csv"` },
  });
}
