import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "../platform/context";
import { ValidationError } from "../platform/errors";
import { requirePermission } from "../platform/permissions";

export type CustomerSummary = {
  id: string;
  name: string;
  paymentTerms: string | null;
  ownerName: string | null;
  primaryContact: string | null;
  contactCount: number;
  priceListId: string | null;
  priceListName: string | null;
};

export type Contact = {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
};

export type CustomerDetail = CustomerSummary & { createdAt: Date; contacts: Contact[]; billingAddress: string | null; shippingAddress: string | null };

const SUMMARY_SQL = `
  select c.id, c.name, c.payment_terms as "paymentTerms", c.created_at as "createdAt",
         u.name as "ownerName", c.price_list_id as "priceListId",
         (select pl.name from price_lists pl where pl.id = c.price_list_id) as "priceListName",
         (select k.name from contacts k where k.customer_id = c.id
            order by k.is_primary desc, k.created_at limit 1) as "primaryContact",
         (select count(*)::int from contacts k where k.customer_id = c.id) as "contactCount"
  from customers c
  left join users u on u.id = c.owner_user_id`;

export async function listCustomers(ctx: Ctx, options: { search?: string } = {}): Promise<CustomerSummary[]> {
  requirePermission(ctx, "customer.read");
  const search = options.search?.trim() ?? "";
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<CustomerSummary>(
      `${SUMMARY_SQL}
       where c.status = 'active' and ($1 = '' or c.name ilike '%' || $1 || '%')
       order by lower(c.name)
       limit 200`,
      [search],
    );
    return result.rows;
  });
}

export async function getCustomer(ctx: Ctx, id: string): Promise<CustomerDetail | null> {
  requirePermission(ctx, "customer.read");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const customer = await tx.query<CustomerSummary & { createdAt: Date; billingAddress: string | null; shippingAddress: string | null }>(
      `select q.*, a.billing_address as "billingAddress", a.shipping_address as "shippingAddress"
         from (${SUMMARY_SQL} where c.id = $1) q join customers a on a.id = q.id`,
      [id],
    );
    const row = customer.rows[0];
    if (!row) return null;
    const contacts = await tx.query<Contact>(
      `select id, name, title, email, phone, is_primary as "isPrimary"
       from contacts where customer_id = $1 order by is_primary desc, created_at`,
      [id],
    );
    return { ...row, contacts: contacts.rows };
  });
}

export async function createCustomer(
  ctx: Ctx,
  input: { name: string; paymentTerms?: string },
): Promise<{ id: string }> {
  requirePermission(ctx, "customer.write");
  const name = input.name.trim();
  const paymentTerms = input.paymentTerms?.trim() || null;
  if (name.length === 0) throw new ValidationError("name", "Enter the customer's name.");
  if (name.length > 200) throw new ValidationError("name", "Keep the name under 200 characters.");
  if (paymentTerms && paymentTerms.length > 50) {
    throw new ValidationError("paymentTerms", "Keep payment terms under 50 characters.");
  }
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const created = await tx.query<{ id: string }>(
      "insert into customers (org_id, name, payment_terms, owner_user_id) values ($1, $2, $3, $4) returning id",
      [ctx.orgId, name, paymentTerms, ctx.userId],
    );
    const id = created.rows[0]!.id;
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
       values ($1, 'user', $2, 'customer.created', 'customer', $3, $4)`,
      [ctx.orgId, ctx.userId, id, JSON.stringify({ name, paymentTerms })],
    );
    return { id };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function audit(tx: { query: (sql: string, params: unknown[]) => Promise<unknown> }, ctx: Ctx, action: string, type: string, id: string, after: unknown) {
  await tx.query(
    `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
     values ($1, 'user', $2, $3, $4, $5, $6)`,
    [ctx.orgId, ctx.userId, action, type, id, JSON.stringify(after)],
  );
}

/** Archived customers, for the "Archived" view. They keep their orders and invoices. */
export async function listArchivedCustomers(ctx: Ctx): Promise<CustomerSummary[]> {
  requirePermission(ctx, "customer.read");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<CustomerSummary>(`${SUMMARY_SQL} where c.status = 'archived' order by lower(c.name) limit 200`);
    return result.rows;
  });
}

export async function customerStatus(ctx: Ctx, id: string): Promise<"active" | "archived" | null> {
  requirePermission(ctx, "customer.read");
  if (!UUID.test(id)) return null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<{ status: "active" | "archived" }>("select status from customers where id = $1", [id]);
    return result.rows[0]?.status ?? null;
  });
}

export async function updateCustomer(
  ctx: Ctx,
  id: string,
  input: { name: string; paymentTerms?: string; billingAddress?: string; shippingAddress?: string },
): Promise<void> {
  requirePermission(ctx, "customer.write");
  const name = input.name.trim();
  const paymentTerms = input.paymentTerms?.trim() || null;
  if (name.length === 0) throw new ValidationError("name", "Enter the customer's name.");
  if (name.length > 200) throw new ValidationError("name", "Keep the name under 200 characters.");
  if (paymentTerms && paymentTerms.length > 50) throw new ValidationError("paymentTerms", "Keep payment terms under 50 characters.");
  if (!UUID.test(id)) throw new ValidationError("id", "Customer not found.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    // An address left out of the request is kept as it is; one sent blank is cleared.
    const address = (value: string | undefined) => (value === undefined ? undefined : value.trim().slice(0, 500) || null);
    const billing = address(input.billingAddress);
    const shipping = address(input.shippingAddress);
    const done = await tx.query(
      `update customers set name = $2, payment_terms = $3,
              billing_address = case when $4 then $5 else billing_address end,
              shipping_address = case when $6 then $7 else shipping_address end,
              updated_at = now()
        where id = $1`,
      [id, name, paymentTerms, billing !== undefined, billing ?? null, shipping !== undefined, shipping ?? null],
    );
    if (done.rowCount === 0) throw new ValidationError("id", "Customer not found.");
    await audit(tx, ctx, "customer.updated", "customer", id, { name, paymentTerms });
  });
}

/** Archiving hides a customer from lists and new orders. Nothing is deleted, and it can be restored. */
export async function setCustomerArchived(ctx: Ctx, id: string, archived: boolean): Promise<void> {
  requirePermission(ctx, "customer.write");
  if (!UUID.test(id)) throw new ValidationError("id", "Customer not found.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    if (archived) {
      const open = await tx.query<{ n: number }>(
        "select count(*)::int as n from sales_orders where customer_id = $1 and status in ('confirmed', 'partially_shipped')",
        [id],
      );
      if (open.rows[0]!.n > 0) {
        throw new ValidationError("id", "This customer has open orders. Ship or cancel them before archiving.");
      }
    }
    const done = await tx.query("update customers set status = $2, updated_at = now() where id = $1", [id, archived ? "archived" : "active"]);
    if (done.rowCount === 0) throw new ValidationError("id", "Customer not found.");
    await audit(tx, ctx, archived ? "customer.archived" : "customer.restored", "customer", id, {});
  });
}

export type ContactInput = { name: string; title?: string; email?: string; phone?: string; isPrimary?: boolean };

function cleanContact(input: ContactInput) {
  const name = input.name.trim();
  const email = input.email?.trim() || null;
  if (name.length === 0) throw new ValidationError("name", "Enter the contact's name.");
  if (name.length > 200) throw new ValidationError("name", "Keep the name under 200 characters.");
  if (email && (!EMAIL.test(email) || email.length > 200)) throw new ValidationError("email", "Enter a valid email address.");
  return { name, title: input.title?.trim().slice(0, 100) || null, email, phone: input.phone?.trim().slice(0, 50) || null, isPrimary: input.isPrimary ?? false };
}

/** Adds a contact, or changes one when contactId is given. Marking one as primary unmarks the others. */
export async function saveContact(ctx: Ctx, customerId: string, input: ContactInput, contactId?: string): Promise<{ id: string }> {
  requirePermission(ctx, "customer.write");
  const c = cleanContact(input);
  if (!UUID.test(customerId) || (contactId !== undefined && !UUID.test(contactId))) throw new ValidationError("id", "Customer not found.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const customer = await tx.query("select 1 from customers where id = $1", [customerId]);
    if (customer.rowCount === 0) throw new ValidationError("id", "Customer not found.");
    if (c.isPrimary) await tx.query("update contacts set is_primary = false where customer_id = $1", [customerId]);
    let id = contactId;
    if (id) {
      const done = await tx.query(
        "update contacts set name = $3, title = $4, email = $5, phone = $6, is_primary = $7, updated_at = now() where id = $1 and customer_id = $2",
        [id, customerId, c.name, c.title, c.email, c.phone, c.isPrimary],
      );
      if (done.rowCount === 0) throw new ValidationError("id", "Contact not found.");
    } else {
      const created = await tx.query<{ id: string }>(
        "insert into contacts (org_id, customer_id, name, title, email, phone, is_primary) values ($1, $2, $3, $4, $5, $6, $7) returning id",
        [ctx.orgId, customerId, c.name, c.title, c.email, c.phone, c.isPrimary],
      );
      id = created.rows[0]!.id;
    }
    await audit(tx, ctx, contactId ? "contact.updated" : "contact.created", "customer", customerId, { contact: c.name });
    return { id };
  });
}

export async function removeContact(ctx: Ctx, customerId: string, contactId: string): Promise<void> {
  requirePermission(ctx, "customer.write");
  if (!UUID.test(customerId) || !UUID.test(contactId)) throw new ValidationError("id", "Contact not found.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const gone = await tx.query<{ name: string }>("delete from contacts where id = $1 and customer_id = $2 returning name", [contactId, customerId]);
    if (gone.rowCount === 0) throw new ValidationError("id", "Contact not found.");
    await audit(tx, ctx, "contact.removed", "customer", customerId, { contact: gone.rows[0]!.name });
  });
}
