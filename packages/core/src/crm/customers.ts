import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "../platform/context";
import { requirePermission } from "../platform/permissions";

export type CustomerSummary = {
  id: string;
  name: string;
  paymentTerms: string | null;
  ownerName: string | null;
  primaryContact: string | null;
  contactCount: number;
};

export type Contact = {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
};

export type CustomerDetail = CustomerSummary & { createdAt: Date; contacts: Contact[] };

export class ValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const SUMMARY_SQL = `
  select c.id, c.name, c.payment_terms as "paymentTerms", c.created_at as "createdAt",
         u.name as "ownerName",
         (select k.name from contacts k where k.customer_id = c.id
            order by k.is_primary desc, k.created_at limit 1) as "primaryContact",
         (select count(*)::int from contacts k where k.customer_id = c.id) as "contactCount"
  from customers c
  left join users u on u.id = c.owner_user_id`;

export async function listCustomers(ctx: Ctx, options: { search?: string } = {}): Promise<CustomerSummary[]> {
  requirePermission(ctx.role, "customer.read");
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
  requirePermission(ctx.role, "customer.read");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const customer = await tx.query<CustomerSummary & { createdAt: Date }>(`${SUMMARY_SQL} where c.id = $1`, [id]);
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
  requirePermission(ctx.role, "customer.write");
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
