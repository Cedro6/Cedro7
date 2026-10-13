import { withTenant } from "@bos/db/runtime";
import { postMovements } from "../inventory/ledger";
import type { Ctx } from "./context";
import { ValidationError } from "./errors";
import { featureOn } from "./features";
import { can, requirePermission } from "./permissions";

/**
 * Bringing a business's existing records in from a spreadsheet saved as CSV.
 *
 * It works in two steps so nothing is a surprise: `planImport` reads the file and says, row by
 * row, what would happen; `runImport` does exactly that, all in one go or not at all.
 * Records that already exist (same customer name, same product code) are left alone, so the
 * same file can be imported twice without making duplicates.
 */

export const IMPORT_KINDS = ["customers", "products"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export const isImportKind = (v: unknown): v is ImportKind => (IMPORT_KINDS as readonly unknown[]).includes(v);

export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_MAX_BYTES = 700_000;

type Column = { key: string; label: string; required?: boolean; names: string[]; example: string };

/** The columns each import understands. `names` are other headings people commonly use for the same thing. */
export const IMPORT_COLUMNS: Record<ImportKind, Column[]> = {
  customers: [
    { key: "name", label: "Name", required: true, names: ["name", "customer", "customer name", "company", "company name", "business name"], example: "Bayside Hardware" },
    { key: "paymentTerms", label: "Payment terms", names: ["payment terms", "terms"], example: "Net 30" },
    { key: "billingAddress", label: "Billing address", names: ["billing address", "bill to", "address"], example: "12 Harbor Rd, Portland, ME 04101" },
    { key: "shippingAddress", label: "Shipping address", names: ["shipping address", "ship to", "delivery address"], example: "12 Harbor Rd, Portland, ME 04101" },
    { key: "contactName", label: "Contact name", names: ["contact name", "contact", "contact person"], example: "Dana Whitfield" },
    { key: "contactEmail", label: "Contact email", names: ["contact email", "email", "e-mail", "email address"], example: "dana@bayside.example" },
    { key: "contactPhone", label: "Contact phone", names: ["contact phone", "phone", "telephone", "phone number"], example: "207-555-0142" },
  ],
  products: [
    { key: "sku", label: "Code", required: true, names: ["code", "sku", "product code", "item code", "item number", "part number"], example: "GL-WK-L" },
    { key: "name", label: "Name", required: true, names: ["name", "product", "product name", "description", "item", "item name"], example: "Work gloves, large, pair" },
    { key: "category", label: "Category", names: ["category", "group", "type", "department"], example: "Safety" },
    { key: "price", label: "Price", names: ["price", "sale price", "selling price", "unit price", "retail price"], example: "4.25" },
    { key: "cost", label: "Cost", names: ["cost", "unit cost", "purchase price", "cost price"], example: "2.40" },
    { key: "barcode", label: "Barcode", names: ["barcode", "upc", "ean", "gtin"], example: "036000291452" },
    { key: "shelfLocation", label: "Shelf location", names: ["shelf location", "location", "shelf", "bin"], example: "A-03-2" },
    { key: "reorderPoint", label: "Reorder point", names: ["reorder point", "reorder level", "minimum", "min stock", "reorder at"], example: "50" },
    { key: "onHand", label: "On hand", names: ["on hand", "quantity", "qty", "stock", "quantity on hand", "in stock", "opening stock"], example: "280" },
  ],
};

/** A blank file with the right headings and one example row, to fill in. */
export function importTemplate(kind: ImportKind): string {
  const columns = IMPORT_COLUMNS[kind];
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `${columns.map((c) => quote(c.label)).join(",")}\r\n${columns.map((c) => quote(c.example)).join(",")}\r\n`;
}

/** Reads CSV text into rows of cells. Handles quoted cells, doubled quotes, line breaks inside quotes, and tab or semicolon files. */
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^﻿/, "");
  const firstLine = input.slice(0, input.search(/\r|\n|$/));
  const countOf = (ch: string) => firstLine.split(ch).length - 1;
  const sep = countOf("\t") > countOf(",") ? "\t" : countOf(";") > countOf(",") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
}

export type ImportRow = {
  /** The row's number in the file, counting the heading row as 1. */
  line: number;
  /** What the row is called on screen: the customer's name, or the product's code and name. */
  label: string;
  action: "add" | "skip" | "error";
  /** Why it is skipped or wrong, or a remark on a row that will be added. */
  note: string;
};

export type ImportPlan = {
  kind: ImportKind;
  /** The file's headings, each with the field it was matched to, or null when it will be ignored. */
  headings: { heading: string; column: string | null }[];
  rows: ImportRow[];
  add: number;
  skip: number;
  errors: number;
  /** Things worth knowing about the whole file, such as a column this role cannot fill in. */
  notes: string[];
};

type Values = Record<string, string>;
type Ready = { row: ImportRow; values: Values };

const norm = (s: string) => s.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Reads "1,250.50" or "$4.25" as a number. Blank is null; anything else that is not a number is NaN. */
function number(value: string | undefined): number | null {
  const v = (value ?? "").replace(/[$\s,]/g, "");
  if (v === "") return null;
  return /^-?\d*\.?\d+$/.test(v) ? Number(v) : Number.NaN;
}

function read(kind: ImportKind, text: string): { headings: ImportPlan["headings"]; records: { line: number; values: Values }[] } {
  if (Buffer.byteLength(text, "utf8") > IMPORT_MAX_BYTES) throw new ValidationError("file", "That file is too large. Split it into files of at most 2,000 rows.");
  const table = parseCsv(text);
  if (table.length < 2) throw new ValidationError("file", "The file needs a heading row and at least one row under it.");
  if (table.length - 1 > IMPORT_MAX_ROWS) throw new ValidationError("file", `That file has ${table.length - 1} rows. Import at most ${IMPORT_MAX_ROWS} at a time.`);
  const columns = IMPORT_COLUMNS[kind];
  const taken = new Set<string>();
  const headings = table[0]!.map((heading) => {
    const match = columns.find((c) => !taken.has(c.key) && (norm(c.label) === norm(heading) || c.names.includes(norm(heading))));
    if (match) taken.add(match.key);
    return { heading, column: match?.key ?? null };
  });
  const missing = columns.filter((c) => c.required && !taken.has(c.key));
  if (missing.length > 0) {
    throw new ValidationError("file", `The file has no "${missing[0]!.label}" column. The first row must be headings, such as: ${columns.map((c) => c.label).join(", ")}.`);
  }
  const records = table.slice(1).map((cells, i) => {
    const values: Values = {};
    headings.forEach((h, c) => { if (h.column) values[h.column] = cells[c] ?? ""; });
    return { line: i + 2, values };
  });
  return { headings, records };
}

async function plan(ctx: Ctx, kind: ImportKind, text: string): Promise<{ plan: ImportPlan; ready: Ready[] }> {
  requirePermission(ctx, kind === "customers" ? "customer.write" : "product.write");
  const { headings, records } = read(kind, text);
  const has = (key: string) => headings.some((h) => h.column === key);
  const notes: string[] = [];
  const ignored = headings.filter((h) => !h.column && h.heading).map((h) => h.heading);
  if (ignored.length > 0) notes.push(`${ignored.length === 1 ? "This column is" : "These columns are"} not used: ${ignored.join(", ")}.`);
  const seeCost = can(ctx, "product.cost.view");
  const stock = featureOn(ctx.features, "stock") && can(ctx, "stock.adjust");
  if (kind === "products" && has("cost") && !seeCost) notes.push("Your role cannot set cost, so the Cost column is left out.");
  if (kind === "products" && has("onHand") && !stock) notes.push("Stock is off for this company or your role cannot adjust it, so the On hand column is left out.");

  const existing = await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    if (kind === "customers") {
      const r = await tx.query<{ name: string }>("select name from customers");
      return { names: new Set(r.rows.map((x) => norm(x.name))), skus: new Set<string>(), barcodes: new Set<string>() };
    }
    const r = await tx.query<{ sku: string; barcode: string | null }>("select sku, barcode from products");
    return { names: new Set<string>(), skus: new Set(r.rows.map((x) => x.sku.toLowerCase())), barcodes: new Set(r.rows.flatMap((x) => (x.barcode ? [x.barcode] : []))) };
  });

  const seen = new Set<string>();
  const seenBarcodes = new Set<string>();
  const ready: Ready[] = [];
  const rows = records.map(({ line, values: v }): ImportRow => {
    const fail = (label: string, note: string): ImportRow => ({ line, label, action: "error", note });
    if (kind === "customers") {
      const name = (v.name ?? "").trim();
      if (!name) return fail("(no name)", "The name is missing.");
      if (name.length > 200) return fail(name.slice(0, 60), "The name is longer than 200 characters.");
      if ((v.paymentTerms ?? "").length > 50) return fail(name, "Payment terms are longer than 50 characters.");
      const email = (v.contactEmail ?? "").trim();
      if (email && (!EMAIL.test(email) || email.length > 200)) return fail(name, `"${email}" is not a valid email address.`);
      if (existing.names.has(norm(name))) return { line, label: name, action: "skip", note: "Already a customer." };
      if (seen.has(norm(name))) return { line, label: name, action: "skip", note: "Same name as an earlier row in this file." };
      seen.add(norm(name));
      const contact = (v.contactName ?? "").trim() || (email || (v.contactPhone ?? "").trim() ? name : "");
      const row: ImportRow = { line, label: name, action: "add", note: contact ? `With contact ${contact}.` : "" };
      ready.push({ row, values: { ...v, name, contactEmail: email, contactName: contact } });
      return row;
    }
    const sku = (v.sku ?? "").trim();
    const name = (v.name ?? "").trim();
    const label = [sku, name].filter(Boolean).join(" · ") || "(blank)";
    if (!sku) return fail(label, "The code is missing.");
    if (sku.length > 60) return fail(label.slice(0, 60), "The code is longer than 60 characters.");
    if (!name) return fail(label, "The name is missing.");
    if (name.length > 200) return fail(label.slice(0, 60), "The name is longer than 200 characters.");
    const amounts: Record<string, number | null> = {};
    for (const [key, what] of [["price", "price"], ["cost", "cost"], ["reorderPoint", "reorder point"], ["onHand", "on hand quantity"]] as const) {
      const n = number(v[key]);
      if (n !== null && (Number.isNaN(n) || n < 0 || n > 1e9)) return fail(label, `The ${what} "${v[key]}" is not a number of zero or more.`);
      amounts[key] = n;
    }
    if (amounts.onHand != null && Math.round(amounts.onHand * 1e4) !== amounts.onHand * 1e4) return fail(label, "The on hand quantity has more than 4 decimal places.");
    const barcode = (v.barcode ?? "").replace(/\s+/g, "");
    if (barcode && !/^[A-Za-z0-9._-]{3,64}$/.test(barcode)) return fail(label, `The barcode "${barcode}" is not 3 to 64 letters and digits.`);
    if (existing.skus.has(sku.toLowerCase())) return { line, label, action: "skip", note: "A product with this code already exists." };
    if (seen.has(sku.toLowerCase())) return { line, label, action: "skip", note: "Same code as an earlier row in this file." };
    if (barcode && (existing.barcodes.has(barcode) || seenBarcodes.has(barcode))) return fail(label, `Another product already has the barcode ${barcode}.`);
    seen.add(sku.toLowerCase());
    if (barcode) seenBarcodes.add(barcode);
    const opening = stock ? (amounts.onHand ?? 0) : 0;
    const remarks = [amounts.price === null ? "No price given, set to $0." : "", opening > 0 ? `Opening stock ${opening}.` : ""].filter(Boolean);
    const row: ImportRow = { line, label, action: "add", note: remarks.join(" ") };
    ready.push({
      row,
      values: {
        sku, name, barcode,
        category: (v.category ?? "").trim().slice(0, 100),
        shelfLocation: (v.shelfLocation ?? "").trim().slice(0, 50),
        price: String(amounts.price ?? 0),
        cost: String(seeCost ? (amounts.cost ?? 0) : 0),
        reorderPoint: amounts.reorderPoint === null ? "" : String(amounts.reorderPoint),
        onHand: String(opening),
      },
    });
    return row;
  });
  const count = (a: ImportRow["action"]) => rows.filter((r) => r.action === a).length;
  return { plan: { kind, headings, rows, add: count("add"), skip: count("skip"), errors: count("error"), notes }, ready };
}

/** Reads a file and reports what importing it would do. Changes nothing. */
export async function planImport(ctx: Ctx, kind: ImportKind, text: string): Promise<ImportPlan> {
  return (await plan(ctx, kind, text)).plan;
}

/**
 * Imports every row the plan marks "add", in one transaction: if anything fails, nothing is imported.
 * `key` identifies this import, so opening stock is never posted twice if the request is repeated.
 */
export async function runImport(ctx: Ctx, kind: ImportKind, text: string, key: string): Promise<ImportPlan> {
  const { plan: result, ready } = await plan(ctx, kind, text);
  if (ready.length === 0) return result;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(key)) throw new ValidationError("key", "The import could not be identified. Reload the page and try again.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const opening: { productId: string; qtyDelta: number; unitCost: number }[] = [];
    for (const { values: v } of ready) {
      if (kind === "customers") {
        const address = (s: string | undefined) => (s ?? "").trim().slice(0, 500) || null;
        const created = await tx.query<{ id: string }>(
          `insert into customers (org_id, name, payment_terms, owner_user_id, billing_address, shipping_address)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [ctx.orgId, v.name, (v.paymentTerms ?? "").trim() || null, ctx.userId, address(v.billingAddress), address(v.shippingAddress)],
        );
        if (v.contactName) {
          await tx.query(
            "insert into contacts (org_id, customer_id, name, email, phone, is_primary) values ($1, $2, $3, $4, $5, true)",
            [ctx.orgId, created.rows[0]!.id, v.contactName.slice(0, 200), v.contactEmail || null, (v.contactPhone ?? "").trim().slice(0, 50) || null],
          );
        }
      } else {
        const created = await tx.query<{ id: string }>(
          `insert into products (org_id, sku, name, category, price, cost, shelf_location, reorder_point, barcode)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [ctx.orgId, v.sku, v.name, v.category || null, Number(v.price), Number(v.cost), v.shelfLocation || null, v.reorderPoint === "" ? null : Number(v.reorderPoint), v.barcode || null],
        );
        if (Number(v.onHand) > 0) opening.push({ productId: created.rows[0]!.id, qtyDelta: Number(v.onHand), unitCost: Number(v.cost) });
      }
    }
    if (opening.length > 0) {
      await postMovements(tx, ctx, { idempotencyKey: `import:${key}`, kind: "adjustment", lines: opening, reason: "Opening stock from import" });
    }
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
       values ($1, 'user', $2, $3, 'organization', $1, $4)`,
      [ctx.orgId, ctx.userId, `${kind}.imported`, JSON.stringify({ added: ready.length, skipped: result.skip, errors: result.errors, openingStockLines: opening.length })],
    );
  });
  return result;
}
