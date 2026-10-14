import { can, getDealerFile } from "@bos/core";
import { requireSession } from "../../../../lib/session";

/** A file kept with a deal or a car, for people signed in to that company. `?download=1` saves it instead of showing it. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { ctx } = await requireSession();
  if (!can(ctx, "vehicle.read")) return new Response("Not found", { status: 404 });
  const { id } = await params;
  const file = await getDealerFile(ctx, id);
  if (!file) return new Response("Not found", { status: 404 });
  const how = new URL(request.url).searchParams.has("download") ? "attachment" : "inline";
  return new Response(new Uint8Array(file.data), {
    headers: {
      "content-type": file.contentType,
      "content-disposition": `${how}; filename="${file.name.replace(/[^\w .()-]/g, "_")}"`,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
