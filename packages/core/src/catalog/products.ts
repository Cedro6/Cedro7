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
  onHand: number;
  reserved: number;
  available: number;
  /** Ordered from suppliers and not yet received. */
  onOrder: number;
  /** Available stock is at or below the reorder point. */
  lowStock: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRODUCT_SQL = `
  select p.id, p.sku, p.name, p.category, p.shelf_location as "shelfLocation",
         p.price::float8 as price,
         case when $1 then p.cost::float8 end as cost,
         p.reorder_point::float8 as "reorderPoint",
         coalesce(s.on_hand, 0)::float8 as "onHand",
         coalesce(s.reserved, 0)::float8 as reserved,
         coalesce(s.on_hand - s.reserved, 0)::float8 as available,
         coalesce((select sum(pl.qty - pl.qty_received)
                   from purchase_order_lines pl join purchase_orders po on po.id = pl.order_id
                   where pl.product_id = p.id
                     and po.status in ('approved', 'sent', 'partially_received')), 0)::float8 as "onOrder",
         (p.reorder_point is not null and coalesce(s.on_hand - s.reserved, 0) <= p.reorder_point) as "lowStock"
  from products p
  left join (
    select product_id, sum(on_hand) as on_hand, sum(reserved) as reserved
    from stock_levels group by product_id
  ) s on s.product_id = p.id`;

export async function listProducts(
  ctx: Ctx,
  options: { search?: string; lowStockOnly?: boolean } = {},
): Promise<ProductSummary[]> {
  requirePermission(ctx.role, "product.read");
  const search = options.search?.trim() ?? "";
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<ProductSummary>(
      `select * from (${PRODUCT_SQL} where p.status = 'active') q
       where ($2 = '' or q.name ilike '%' || $2 || '%' or q.sku ilike '%' || $2 || '%')
         and (not $3 or q."lowStock")
       order by q.sku
       limit 500`,
      [can(ctx.role, "product.cost.view"), search, options.lowStockOnly ?? false],
    );
    return result.rows;
  });
}

export async function getProduct(ctx: Ctx, id: string): Promise<ProductSummary | null> {
  requirePermission(ctx.role, "product.read");
  if (!UUID.test(id)) return null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<ProductSummary>(`${PRODUCT_SQL} where p.id = $2`, [
      can(ctx.role, "product.cost.view"),
      id,
    ]);
    return result.rows[0] ?? null;
  });
}
