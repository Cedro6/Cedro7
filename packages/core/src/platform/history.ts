import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "./context";
import { requirePermission } from "./permissions";

/**
 * Who changed what, newest first. The app writes a line to its log on every change; this reads
 * that log back in plain words. Owners and admins only, since it covers everyone's work.
 */
export type HistoryEntry = {
  id: string;
  at: Date;
  /** The person's name, "Assistant" for a change the assistant carried out after confirmation, or "System". */
  who: string;
  /** What happened, written to follow the name: "confirmed order". */
  what: string;
  /** The record it happened to, such as "SO-000012" or a customer's name. Empty when there is none. */
  subject: string;
  /** Where to open that record, when it has a page. */
  href: string | null;
  /** Extra facts recorded with the change, such as an amount or a reason. */
  detail: string;
  area: HistoryArea;
};

export const HISTORY_AREAS = ["sales", "customers", "products", "money", "purchasing", "settings"] as const;
export type HistoryArea = (typeof HISTORY_AREAS)[number];
export const isHistoryArea = (v: unknown): v is HistoryArea => (HISTORY_AREAS as readonly unknown[]).includes(v);

/** Which actions belong to each area, by the first part of the action's name. */
const AREA_PREFIXES: Record<HistoryArea, string[]> = {
  sales: ["sales_order", "return", "price_list"],
  customers: ["customer", "contact", "customers"],
  products: ["product", "stock", "products"],
  money: ["invoice", "credit_note", "expense"],
  purchasing: ["purchase_order", "supplier"],
  settings: ["settings", "company", "member", "assistant"],
};
const areaOf = (action: string): HistoryArea => {
  const prefix = action.split(".")[0]!;
  return HISTORY_AREAS.find((a) => AREA_PREFIXES[a].includes(prefix)) ?? "settings";
};

const WHAT: Record<string, string> = {
  "sales_order.created": "created quote",
  "sales_order.confirmed": "confirmed order",
  "sales_order.reserved": "reserved stock for order",
  "sales_order.shipped": "shipped order",
  "sales_order.completed": "completed order",
  "sales_order.cancelled": "cancelled order",
  "return.created": "took a return on order",
  "price_list.created": "created price list",
  "price_list.deleted": "deleted price list",
  "customer.created": "added customer",
  "customer.updated": "edited customer",
  "customer.archived": "archived customer",
  "customer.restored": "restored customer",
  "customer.price_list_changed": "changed the price list for customer",
  "contact.created": "added a contact to",
  "contact.updated": "edited a contact of",
  "contact.removed": "removed a contact from",
  "customer.refunded": "paid a refund to",
  "customers.imported": "imported customers from a spreadsheet",
  "product.created": "added product",
  "product.updated": "edited product",
  "product.archived": "archived product",
  "product.restored": "restored product",
  "products.imported": "imported products from a spreadsheet",
  "stock.adjusted": "adjusted the stock of",
  "stock.counted": "posted a stock count",
  "invoice.created": "created invoice",
  "invoice.raised": "raised invoice",
  "invoice.deposit_requested": "raised deposit invoice",
  "invoice.payment_recorded": "recorded a payment on invoice",
  "invoice.credit_used": "used account credit on invoice",
  "invoice.voided": "voided invoice",
  "credit_note.raised": "raised credit note",
  "expense.created": "recorded bill or expense",
  "expense.paid": "marked as paid",
  "expense.voided": "voided bill or expense",
  "purchase_order.created": "created purchase order",
  "purchase_order.submitted": "submitted purchase order",
  "purchase_order.approved": "approved purchase order",
  "purchase_order.sent": "marked as sent purchase order",
  "purchase_order.received": "received goods on purchase order",
  "purchase_order.cancelled": "cancelled purchase order",
  "supplier.created": "added supplier",
  "supplier.updated": "edited supplier",
  "supplier.archived": "archived supplier",
  "supplier.restored": "restored supplier",
  "settings.feature_changed": "switched a feature",
  "settings.business_type_changed": "changed the business type",
  "company.updated": "edited the company details",
  "company.two_step_rule": "changed whether two-step verification is required",
  "company.created": "created the company",
  "company.region_updated": "changed the time zone, currency or tax rate",
  "member.invited": "invited",
  "member.updated": "changed the role or access of",
  "member.password_link": "made a password link for",
  "member.two_step_on": "turned on two-step verification for",
  "member.two_step_off": "turned off two-step verification for",
  "member.two_step_reset": "reset two-step verification for",
  "assistant.confirmed": "confirmed a change the assistant prepared",
};

/** The recorded facts worth showing, in plain words. Unknown keys are left out rather than shown raw. */
const FACTS: [key: string, show: (v: unknown) => string][] = [
  ["reason", (v) => `Reason: ${v}`],
  ["amount", (v) => `Amount ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
  ["units", (v) => `${v} units`],
  ["qtyDelta", (v) => `${Number(v) > 0 ? "+" : ""}${v} units`],
  ["shipmentNumber", (v) => `Shipment ${v}`],
  ["creditNoteNumber", (v) => `Credit note ${v}`],
  ["method", (v) => `By ${String(v).toLowerCase()}`],
  ["contact", (v) => `Contact: ${v}`],
  ["feature", (v) => `Feature: ${v}`],
  ["on", (v) => (v ? "Turned on" : "Turned off")],
  ["businessType", (v) => `Now: ${v}`],
  ["role", (v) => `Role: ${v}`],
  ["status", (v) => `Now ${v}`],
  ["added", (v) => `${v} added`],
  ["skipped", (v) => `${v} skipped`],
  ["timeZone", (v) => String(v)],
  ["currency", (v) => String(v)],
];
function detailOf(after: unknown): string {
  if (!after || typeof after !== "object") return "";
  const o = after as Record<string, unknown>;
  return FACTS.flatMap(([key, show]) => {
    const v = o[key];
    return v === undefined || v === null || v === "" || typeof v === "object" ? [] : [show(v).slice(0, 120)];
  }).join(" · ");
}

const HREF: Record<string, (id: string) => string> = {
  sales_order: (id) => `/sales/${id}`,
  customer: (id) => `/customers/${id}`,
  product: (id) => `/products/${id}`,
  invoice: (id) => `/invoices/${id}`,
  purchase_order: (id) => `/purchasing/${id}`,
  supplier: (id) => `/purchasing/suppliers/${id}`,
  expense: (id) => `/bills/${id}`,
};

export const HISTORY_PAGE = 50;

export async function listHistory(
  ctx: Ctx,
  options: { area?: HistoryArea; userId?: string; before?: string } = {},
): Promise<{ entries: HistoryEntry[]; next: string | null }> {
  requirePermission(ctx, "settings.manage");
  const prefixes = options.area ? AREA_PREFIXES[options.area].map((p) => `${p}.%`) : null;
  const userId = options.userId && /^[0-9a-f-]{36}$/i.test(options.userId) ? options.userId : null;
  // The cursor is the last entry shown: its time and id, since several changes can share one instant.
  const [beforeAt = "", beforeId = ""] = (options.before ?? "").split("|");
  const before = !Number.isNaN(Date.parse(beforeAt)) && /^[0-9a-f-]{36}$/i.test(beforeId) ? { at: beforeAt, id: beforeId } : null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const r = await tx.query<{ id: string; at: Date; actor_type: string; actor: string | null; cursor: string; action: string; entity_type: string; entity_id: string | null; after: unknown; subject: string | null }>(
      `select a.id, a.created_at as at, to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor, a.actor_type, u.name as actor, a.action, a.entity_type, a.entity_id, a.after,
              case a.entity_type
                when 'sales_order' then (select number from sales_orders where id = a.entity_id)
                when 'customer' then (select name from customers where id = a.entity_id)
                when 'product' then (select name from products where id = a.entity_id)
                when 'invoice' then (select number from invoices where id = a.entity_id)
                when 'credit_note' then (select number from credit_notes where id = a.entity_id)
                when 'purchase_order' then (select number from purchase_orders where id = a.entity_id)
                when 'supplier' then (select name from suppliers where id = a.entity_id)
                when 'expense' then (select description from expenses where id = a.entity_id)
                when 'price_list' then (select name from price_lists where id = a.entity_id)
                when 'user' then (select name from users where id = a.entity_id)
                when 'membership' then (select uu.name from memberships m join users uu on uu.id = m.user_id where m.id = a.entity_id)
              end as subject
         from audit_log a left join users u on u.id = a.actor_id
        where ($1::text[] is null or a.action like any ($1))
          and ($2::uuid is null or a.actor_id = $2)
          and ($3::timestamptz is null or (a.created_at, a.id) < ($3::timestamptz, $4::uuid))
        order by a.created_at desc, a.id desc limit ${HISTORY_PAGE + 1}`,
      [prefixes, userId, before?.at ?? null, before?.id ?? null],
    );
    const rows = r.rows.slice(0, HISTORY_PAGE);
    return {
      entries: rows.map((row) => ({
        id: row.id,
        at: row.at,
        who: row.actor_type === "ai" ? "Assistant" : (row.actor ?? "System"),
        what: WHAT[row.action] ?? row.action.replace(/[._]/g, " "),
        subject: row.subject ?? "",
        href: row.entity_id && row.subject && HREF[row.entity_type] ? HREF[row.entity_type]!(row.entity_id) : null,
        detail: detailOf(row.after),
        area: areaOf(row.action),
      })),
      next: r.rows.length > HISTORY_PAGE ? `${rows.at(-1)!.cursor}|${rows.at(-1)!.id}` : null,
    };
  });
}
