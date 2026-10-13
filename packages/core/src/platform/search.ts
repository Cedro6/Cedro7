import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "./context";
import { featureOn } from "./features";
import { can } from "./permissions";

/**
 * One search across the company's records. Each kind of record is only searched when this
 * person's role may see it, and results link straight to the record.
 */
export type SearchHit = { id: string; title: string; detail: string; href: string };
export type SearchGroup = { kind: "customers" | "products" | "orders" | "invoices" | "purchase_orders" | "suppliers" | "bills"; label: string; hits: SearchHit[]; more: boolean;
  /** True when nothing matched exactly and these are near misses, such as a misspelt name. */
  close?: boolean };

export const SEARCH_MIN = 2;
const LIMIT = 6;

export async function search(ctx: Ctx, query: string): Promise<SearchGroup[]> {
  const q = query.trim().slice(0, 80);
  if (q.length < SEARCH_MIN) return [];
  // The text is matched anywhere in the field; % and _ typed by the person are matched as themselves.
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  // A record whose name or number starts with the text comes before one that only contains it.
  const starts = `${q.replace(/[\\%_]/g, "\\$&")}%`;
  const groups: SearchGroup[] = [];
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const run = async (kind: SearchGroup["kind"], label: string, sql: string) => {
      const r = await tx.query<SearchHit>(`${sql} limit ${LIMIT + 1}`, [like, starts]);
      if (r.rows.length > 0) groups.push({ kind, label, hits: r.rows.slice(0, LIMIT), more: r.rows.length > LIMIT });
    };
    if (can(ctx, "customer.read")) {
      await run("customers", "Customers",
        `select c.id, c.name as title,
                coalesce((select 'Contact: ' || k.name || coalesce(' · ' || k.email, '') from contacts k
                           where k.customer_id = c.id and (k.name ilike $1 or k.email ilike $1 or k.phone ilike $1) order by k.is_primary desc limit 1),
                         case when c.status = 'archived' then 'Archived' else coalesce(c.payment_terms, '') end) as detail,
                '/customers/' || c.id as href
           from customers c
          where c.name ilike $1 or exists (select 1 from contacts k where k.customer_id = c.id and (k.name ilike $1 or k.email ilike $1 or k.phone ilike $1))
          order by (c.status = 'archived'), (c.name ilike $2) desc, lower(c.name)`);
    }
    if (can(ctx, "product.read")) {
      await run("products", "Products",
        `select p.id, p.name as title,
                p.sku || coalesce(' · ' || p.category, '') || case when p.status = 'archived' then ' · Archived' else '' end as detail,
                '/products/' || p.id as href
           from products p
          where p.name ilike $1 or p.sku ilike $1 or p.barcode ilike $1 or p.category ilike $1
          order by (p.status = 'archived'), (p.sku ilike $2 or p.name ilike $2) desc, lower(p.name)`);
    }
    if (can(ctx, "sales_order.read")) {
      await run("orders", "Orders and quotes",
        `select o.id, o.number as title, c.name || ' · ' || replace(o.status, '_', ' ') as detail, '/sales/' || o.id as href
           from sales_orders o join customers c on c.id = o.customer_id
          where o.number ilike $1 or c.name ilike $1 or o.notes ilike $1
          order by (o.number ilike $2) desc, o.created_at desc`);
      await run("invoices", "Invoices",
        `select i.id, i.number as title, c.name || case when i.voided_at is not null then ' · void' else '' end as detail, '/invoices/' || i.id as href
           from invoices i join customers c on c.id = i.customer_id
          where i.number ilike $1 or c.name ilike $1
          order by (i.number ilike $2) desc, i.issued_at desc`);
    }
    if (can(ctx, "purchase_order.read")) {
      await run("purchase_orders", "Purchase orders",
        `select po.id, po.number as title, s.name || ' · ' || replace(po.status, '_', ' ') as detail, '/purchasing/' || po.id as href
           from purchase_orders po join suppliers s on s.id = po.supplier_id
          where po.number ilike $1 or s.name ilike $1
          order by (po.number ilike $2) desc, po.created_at desc`);
      await run("suppliers", "Suppliers",
        `select s.id, s.name as title, coalesce(s.email, coalesce(s.phone, '')) as detail, '/purchasing/suppliers/' || s.id as href
           from suppliers s
          where s.name ilike $1 or s.email ilike $1 or s.phone ilike $1
          order by (s.status = 'archived'), (s.name ilike $2) desc, lower(s.name)`);
    }
    if (can(ctx, "expense.read") && featureOn(ctx.features, "expenses")) {
      await run("bills", "Bills and expenses",
        `select e.id, e.description as title,
                e.category || coalesce(' · ' || s.name, '') || coalesce(' · ' || e.reference, '') || case when e.voided_at is not null then ' · voided' else '' end as detail,
                '/bills/' || e.id as href
           from expenses e left join suppliers s on s.id = e.supplier_id
          where e.description ilike $1 or e.reference ilike $1 or s.name ilike $1
          order by (e.voided_at is not null), (e.description ilike $2) desc, e.incurred_on desc`);
    }
    // Nothing matched as typed: look for names that are nearly the same, so a slip of the keyboard still finds the record.
    if (groups.length === 0 && q.length >= 4) {
      const near = async (kind: SearchGroup["kind"], label: string, sql: string) => {
        const rows = (await tx.query<SearchHit>(`${sql} limit 3000`)).rows;
        const scored = rows.map((row) => ({ row, score: Math.max(...row.title.split(/\s*·\s*/).map((part) => likeness(q, part))) })).filter((x) => x.score >= 0.42);
        scored.sort((a, b) => b.score - a.score);
        if (scored.length > 0) groups.push({ kind, label, hits: scored.slice(0, LIMIT).map((x) => x.row), more: scored.length > LIMIT, close: true });
      };
      if (can(ctx, "customer.read")) await near("customers", "Customers", "select id, name as title, coalesce(payment_terms, '') as detail, '/customers/' || id as href from customers where status = 'active' order by name");
      if (can(ctx, "product.read")) await near("products", "Products", "select id, name || ' · ' || sku as title, coalesce(category, '') as detail, '/products/' || id as href from products where status = 'active' order by name");
      if (can(ctx, "purchase_order.read")) await near("suppliers", "Suppliers", "select id, name as title, coalesce(email, '') as detail, '/purchasing/suppliers/' || id as href from suppliers where status = 'active' order by name");
    }
  });
  return groups;
}

/** How alike two pieces of text are, from 0 to 1, by the three-letter runs they share. Forgiving of a wrong or missing letter. */
export function likeness(a: string, b: string): number {
  const grams = (text: string) => {
    const t = `  ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
    const out = new Map<string, number>();
    for (let i = 0; i < t.length - 2; i++) out.set(t.slice(i, i + 3), (out.get(t.slice(i, i + 3)) ?? 0) + 1);
    return out;
  };
  const x = grams(a);
  const y = grams(b);
  let shared = 0;
  let sizeX = 0;
  let sizeY = 0;
  for (const [g, n] of x) { sizeX += n; shared += Math.min(n, y.get(g) ?? 0); }
  for (const n of y.values()) sizeY += n;
  if (sizeX === 0 || sizeY === 0) return 0;
  // Measured against the shorter text, so "bayside" still finds "Bayside Hardware".
  return shared / Math.min(sizeX, sizeY);
}
