import { can, listingRows, toCsv } from "@bos/core";
import { requireSession } from "../../../../lib/session";
import { todayHere } from "../../../../lib/locale";

/**
 * Every car on the lot with an asking price, one row each, in the columns listing sites ask for
 * when you upload inventory. Photo links are public while the car is on the lot.
 */
export async function GET(request: Request): Promise<Response> {
  const { ctx } = await requireSession();
  if (!can(ctx, "vehicle.read")) return new Response("Not found", { status: 404 });
  const rows = await listingRows(ctx);
  const origin = new URL(request.url).origin;
  const csv = toCsv(
    ["stock_number", "vin", "year", "make", "model", "trim", "body_style", "mileage", "price", "exterior_color", "condition", "transmission", "drivetrain", "fuel_type", "description", "photo_urls"],
    rows.map((r) => [
      r.stockNumber, r.vin, r.year, r.make, r.model, r.trim, r.bodyStyle, r.mileage, r.askingPrice.toFixed(2), r.colour, r.condition,
      r.transmission, r.drivetrain, r.fuelType, r.description, r.photoIds.map((p) => `${origin}/photos/${p}`).join(" | "),
    ]),
  );
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="lot-${todayHere()}.csv"`, "cache-control": "no-store" } });
}
