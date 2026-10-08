import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "./context";
import { can } from "./permissions";

export type Overview = { customers: number | null; products: number | null; team: number };

/** Counts for the Home screen. A count the role may not see comes back as null. */
export async function overview(ctx: Ctx): Promise<Overview> {
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<{ customers: number; products: number; team: number }>(
      `select (select count(*)::int from customers where status = 'active') as customers,
              (select count(*)::int from products where status = 'active') as products,
              (select count(*)::int from memberships where status = 'active') as team`,
    );
    const row = result.rows[0]!;
    return {
      customers: can(ctx.role, "customer.read") ? row.customers : null,
      products: can(ctx.role, "product.read") ? row.products : null,
      team: row.team,
    };
  });
}
