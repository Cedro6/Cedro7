import { publicVehiclePhoto } from "@bos/core";
import { pool } from "../../../lib/pool";

/**
 * A photo of a car on the lot, without signing in, so listing sites can show it. Only photos of cars
 * currently on the lot are served, found by their random id; anything else is "not found".
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const photo = await publicVehiclePhoto(pool, id).catch(() => null);
  if (!photo) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(new Uint8Array(photo.data), {
    headers: { "content-type": photo.contentType, "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" },
  });
}
