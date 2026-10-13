import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "./context";
import { featureOn } from "./features";
import { can } from "./permissions";

/**
 * One search across the company's records. Each kind of record is only searched when this
 * person's role may see it, and results link straight to the record.
 */
export type SearchHit = { id: string; title: string; detail: string; href: string };
export type SearchGroup = { kind: "customers" | "products" | "orders" | "invoices" | "purchase_orders" | "suppliers" | "bills"; label: string; hits: SearchHit[]; more: boolean };

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
  });
  return groups;
}
