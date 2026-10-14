import { can, commissionReport, dealerProfit, ForbiddenError, salesTaxReport, toCsv, ValidationError } from "@bos/core";
import { requireSession } from "../../../../lib/session";

/** The dealer reports as spreadsheets: profit per car, sales tax by county, commission by salesperson. */
export async function GET(request: Request): Promise<Response> {
  const { ctx } = await requireSession();
  if (!can(ctx, "report.view")) return new Response("Not found", { status: 404 });
  const q = new URL(request.url).searchParams;
  const from = q.get("from") ?? "";
  const to = q.get("to") ?? "";
  try {
    let name: string;
    let csv: string;
    switch (q.get("report")) {
      case "profit": {
        const { rows } = await dealerProfit(ctx, from, to);
        name = `profit-${from}-to-${to}`;
        csv = toCsv(
          ["delivered_on", "deal", "stock_number", "vehicle", "buyer", "salesperson", "sale_price", "dealer_fee", "car_cost", "spent_on_car", "gross", "commission", "net"],
          rows.map((r) => [r.deliveredOn, r.number, r.stockNumber, r.vehicleName, r.buyerName, r.salespersonName, r.salePrice, r.dealerFee, r.carCost, r.costs, r.gross, r.commission, r.net]),
        );
        break;
      }
      case "tax": {
        const month = q.get("month") ?? "";
        const { rows, totals } = await salesTaxReport(ctx, month);
        name = `sales-tax-${month}`;
        csv = toCsv(
          ["county", "surtax_pct", "cars", "taxable", "state_tax", "surtax_base", "surtax"],
          [...rows.map((r) => [r.county, r.surtaxPct, r.deals, r.taxable, r.stateTax, r.surtaxBase, r.surtax]), ["Total", "", totals.deals, totals.taxable, totals.stateTax, totals.surtaxBase, totals.surtax]],
        );
        break;
      }
      case "commission": {
        const rows = await commissionReport(ctx, from, to);
        name = `commission-${from}-to-${to}`;
        csv = toCsv(["salesperson", "cars", "sales", "commission"], rows.map((r) => [r.name, r.deals, r.sales, r.commission]));
        break;
      }
      default:
        return new Response("Not found", { status: 404 });
    }
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"`, "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ForbiddenError) return new Response("Not allowed", { status: 403 });
    if (error instanceof ValidationError) return new Response(error.message, { status: 400 });
    throw error;
  }
}
