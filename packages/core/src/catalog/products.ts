import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "../platform/context";
import { can, requirePermission } from "../platform/permissions";

export type ProductSummary = {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  shelfLocation: string | null;
  price: number;
  /** Null when the role may not see cost. */
  cost: number | null;
  reorderPoint: number | null;
};

export async function listProducts(ctx: Ctx, options: { search?: string } = {}): Promise<ProductSummary[]> {
  requirePermission(ctx.role, "product.read");
  const search = options.search?.trim() ?? "";
  const showCost = can(ctx.role, "product.cost.view");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<ProductSummary>(
      `select id, sku, name, category, shelf_location as "shelfLocation",
              price::float8 as price,
              case when $2 then cost::float8 end as cost,
              reorder_point::float8 as "reorderPoint"
       from products
       where status = 'active' and ($1 = '' or name ilike '%' || $1 || '%' or sku ilike '%' || $1 || '%')
       order by sku
       limit 500`,
      [search, showCost],
    );
    return result.rows;
  });
}
