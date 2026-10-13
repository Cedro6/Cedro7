import { analysis, can, featureOn, type Analysis, type Pair } from "@bos/core";
import { readReportQuery } from "../../../../lib/report-params";
import { requireSession } from "../../../../lib/session";

type Cell = string | number | null;
const TABLES = ["products", "customers", "categories", "people", "trend", "owed", "idle", "suppliers"] as const;
type Table = (typeof TABLES)[number];

const round = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);
const change = (p: Pair): Cell => (p.was === null || p.was === 0 ? null : Math.round(((p.now - p.was) / p.was) * 1000) / 10);

/** Quotes a cell for a spreadsheet. Text that a spreadsheet would run as a formula is made plain text. */
function cell(value: Cell): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rows(data: Analysis, table: Table): Cell[][] {
  const cmp = data.compare !== null;
  const pair = (p: Pair): Cell[] => (cmp ? [round(p.now), round(p.was), change(p)] : [round(p.now)]);
  const head = (name: string): string[] => (cmp ? [name, `${name} (compared)`, `${name} change %`] : [name]);
  switch (table) {
    case "products": {
      const margin = data.products.some((p) => p.margin !== null);
      return [
        ["SKU", "Product", "Category", ...head("Units"), ...head("Sales"), ...(margin ? head("Margin") : [])],
        ...data.products.map((p) => [p.sku, p.name, p.category ?? "", ...pair(p.units), ...pair(p.revenue), ...(margin && p.margin ? pair(p.margin) : [])]),
      ];
    }
    case "customers":
      return [["Customer", "New", ...head("Orders"), ...head("Sales")], ...data.customers.map((c) => [c.name, c.isNew ? "Yes" : "No", ...pair(c.orders), ...pair(c.revenue)])];
    case "categories":
      return [["Category", ...head("Sales")], ...data.categories.map((c) => [c.name, ...pair(c.revenue)])];
    case "people":
      return [["Person", ...head("Orders"), ...head("Sales")], ...data.people.map((p) => [p.name, ...pair(p.orders), ...pair(p.revenue)])];
    case "trend":
      return [
        [data.bucket === "day" ? "Day" : data.bucket === "week" ? "Week starting" : "Month starting", "Sales", ...(cmp ? ["Compared with", "Sales (compared)"] : [])],
        ...data.trend.map((s) => [s.start, round(s.now), ...(cmp ? [s.wasStart ?? "", round(s.was)] : [])]),
      ];
    case "owed":
      return [["Customer", "Owed", "Overdue", "Oldest days late"], ...data.money.debtors.map((d) => [d.name, round(d.owed), round(d.overdue), d.oldest])];
    case "idle":
      return [["SKU", "Product", "On hand", "Value at cost"], ...(data.stock?.idle ?? []).map((p) => [p.sku, p.name, p.onHand, round(p.value)])];
    case "suppliers":
      return [["Supplier", ...head("Orders"), ...head("Ordered")], ...(data.purchasing?.suppliers ?? []).map((s) => [s.name, ...pair(s.orders), ...pair(s.ordered)])];
  }
}

export async function GET(request: Request) {
  const { ctx } = await requireSession();
  if (!can(ctx, "report.view") || !featureOn(ctx.features, "reports")) return new Response("Reports are not available", { status: 403 });
  const q = Object.fromEntries(new URL(request.url).searchParams);
  const table = (TABLES as readonly string[]).includes(q.table ?? "") ? (q.table as Table) : null;
  if (!table) return new Response("Unknown table", { status: 400 });
  const view = readReportQuery(q);
  const data = await analysis(ctx, { range: view.range, mode: view.mode });
  const body = rows(data, table).map((r) => r.map(cell).join(",")).join("\r\n");
  return new Response(`${String.fromCharCode(0xfeff)}${body}\r\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${table}-${view.range.from}-to-${view.range.to}.csv"`,
      "cache-control": "no-store",
    },
  });
}
