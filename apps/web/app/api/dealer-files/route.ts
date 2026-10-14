import { revalidatePath } from "next/cache";
import { addDealerFile, ForbiddenError, StateError, ValidationError } from "@bos/core";
import { requireSession } from "../../../lib/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Takes one file for a deal (signed papers, the buyer's licence, the title) or a car (a photo).
 * The page's uploader shrinks photos first and asks for JSON back; a plain form post is sent back
 * to the page it came from with a notice, so uploading works without the script too.
 */
export async function POST(request: Request): Promise<Response> {
  const { ctx } = await requireSession();
  const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return reply(wantsJson, null, "That upload could not be read. Try a smaller file.");
  }
  const dealId = String(form.get("dealId") ?? "");
  const vehicleId = String(form.get("vehicleId") ?? "");
  const back = UUID.test(dealId) ? `/deals/${dealId}` : UUID.test(vehicleId) ? `/vehicles/${vehicleId}` : null;
  const files = form.getAll("file").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f && f.size > 0);
  if (!back) return reply(wantsJson, null, "Choose a deal or a vehicle for the file.");
  if (files.length === 0) return reply(wantsJson, back, "Choose a file to upload.");
  try {
    for (const file of files) {
      await addDealerFile(ctx, {
        dealId: dealId || undefined, vehicleId: vehicleId || undefined, kind: String(form.get("kind") ?? "other"),
        name: file.name, contentType: file.type, data: new Uint8Array(await file.arrayBuffer()),
      });
    }
  } catch (error) {
    const message = error instanceof ValidationError || error instanceof StateError ? error.message : error instanceof ForbiddenError ? "You are not allowed to add files here." : "The file could not be saved. Try again.";
    if (!(error instanceof ValidationError || error instanceof StateError || error instanceof ForbiddenError)) console.error("dealer file upload failed", error);
    return reply(wantsJson, back, message);
  }
  revalidatePath(back);
  return reply(wantsJson, back, null, files.length === 1 ? "File added." : `${files.length} files added.`);
}

function reply(json: boolean, back: string | null, error: string | null, notice?: string): Response {
  if (json) return Response.json(error ? { error } : { ok: true, notice }, { status: error ? 400 : 200 });
  const to = `${back ?? "/"}?${error ? `error=${encodeURIComponent(error)}` : `notice=${encodeURIComponent(notice ?? "Saved.")}`}`;
  return new Response(null, { status: 303, headers: { location: to } });
}
