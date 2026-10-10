import { withTenant, type PoolClient } from "@bos/db/runtime";
import type { Ctx } from "../platform/context";
import { StateError, ValidationError } from "../platform/errors";
import { requirePermission } from "../platform/permissions";

/**
 * Price lists. A customer on a price list pays the product's special price when the list
 * has one, and otherwise the product's price less the list's percentage.
 */

export type PriceList = {
  id: string;
  name: string;
  percentOff: number;
  customers: number;
  specialPrices: { productId: string; sku: string; name: string; price: number }[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cents = (value: number): number => Math.round(value * 100) / 100;

/** What this customer pays for each of these products before any line discount. */
export async function customerPricesInTx(
  tx: PoolClient,
  customerId: string,
  productIds: string[],
): Promise<Map<string, number>> {
  const result = await tx.query<{ id: string; price: number }>(
    `select p.id,
            coalesce(sp.price, round(p.price * (1 - coalesce(pl.percent_off, 0) / 100), 2))::float8 as price
     from products p
     left join customers c on c.id = $1
     left join price_lists pl on pl.id = c.price_list_id
     left join price_list_prices sp on sp.price_list_id = pl.id and sp.product_id = p.id
     where p.id = any($2::uuid[]) and p.status = 'active'`,
    [customerId, productIds],
  );
  return new Map(result.rows.map((row) => [row.id, row.price]));
}

/** For the order form: every active product's price for one customer. */
export async function pricesForCustomer(ctx: Ctx, customerId: string): Promise<Record<string, number>> {
  requirePermission(ctx, "sales_order.read");
  if (!UUID.test(customerId)) return {};
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const products = await tx.query<{ id: string }>("select id from products where status = 'active'");
    return Object.fromEntries(await customerPricesInTx(tx, customerId, products.rows.map((row) => row.id)));
  });
}

export async function listPriceLists(ctx: Ctx): Promise<PriceList[]> {
  requirePermission(ctx, "sales_order.read");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const lists = await tx.query<Omit<PriceList, "specialPrices">>(
      `select pl.id, pl.name, pl.percent_off::float8 as "percentOff",
              (select count(*)::int from customers c where c.price_list_id = pl.id) as customers
       from price_lists pl order by lower(pl.name)`,
    );
    const prices = await tx.query<{ listId: string; productId: string; sku: string; name: string; price: number }>(
      `select sp.price_list_id as "listId", p.id as "productId", p.sku, p.name, sp.price::float8 as price
       from price_list_prices sp join products p on p.id = sp.product_id order by p.sku`,
    );
    return lists.rows.map((list) => ({
      ...list,
      specialPrices: prices.rows
        .filter((row) => row.listId === list.id)
        .map((row) => ({ productId: row.productId, sku: row.sku, name: row.name, price: row.price })),
    }));
  });
}

export async function createPriceList(
  ctx: Ctx,
  input: { name: string; percentOff?: number; specialPrices?: { productId: string; price: number }[] },
): Promise<{ id: string }> {
  requirePermission(ctx, "sales_order.write");
  const name = input.name.trim();
  if (!name) throw new ValidationError("name", "Name the price list.");
  if (name.length > 100) throw new ValidationError("name", "Keep the name under 100 characters.");
  const percentOff = input.percentOff ?? 0;
  if (!Number.isFinite(percentOff) || percentOff < 0 || percentOff >= 100) {
    throw new ValidationError("percentOff", "The percentage off must be between 0 and 100.");
  }
  const special = input.specialPrices ?? [];
  for (const row of special) {
    if (!UUID.test(row.productId)) throw new ValidationError("specialPrices", "Choose a product for each special price.");
    if (!Number.isFinite(row.price) || row.price < 0 || row.price > 1e12) {
      throw new ValidationError("specialPrices", "A special price cannot be negative.");
    }
  }
  if (new Set(special.map((row) => row.productId)).size !== special.length) {
    throw new ValidationError("specialPrices", "Each product can have only one special price on a list.");
  }
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const taken = await tx.query("select 1 from price_lists where lower(name) = lower($1)", [name]);
    if (taken.rowCount) throw new ValidationError("name", "There is already a price list with that name.");
    const created = await tx.query<{ id: string }>(
      "insert into price_lists (org_id, name, percent_off) values ($1, $2, $3) returning id",
      [ctx.orgId, name, percentOff],
    );
    const id = created.rows[0]!.id;
    if (special.length) {
      const known = await tx.query("select id from products where id = any($1::uuid[])", [special.map((row) => row.productId)]);
      if (known.rowCount !== special.length) throw new ValidationError("specialPrices", "Choose a product for each special price.");
      for (const row of special) {
        await tx.query("insert into price_list_prices (org_id, price_list_id, product_id, price) values ($1, $2, $3, $4)", [
          ctx.orgId,
          id,
          row.productId,
          cents(row.price),
        ]);
      }
    }
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
       values ($1, 'user', $2, 'price_list.created', 'price_list', $3, $4)`,
      [ctx.orgId, ctx.userId, id, JSON.stringify({ name, percentOff, specialPrices: special.length })],
    );
    return { id };
  });
}

/** Removes a price list. Its customers go back to list prices; existing orders keep the prices they were given. */
export async function deletePriceList(ctx: Ctx, id: string): Promise<{ customers: number }> {
  requirePermission(ctx, "sales_order.write");
  if (!UUID.test(id)) throw new StateError("Price list not found.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const list = await tx.query<{ name: string }>("select name from price_lists where id = $1 for update", [id]);
    if (!list.rows[0]) throw new StateError("Price list not found.");
    const moved = await tx.query("update customers set price_list_id = null where price_list_id = $1", [id]);
    await tx.query("delete from price_lists where id = $1", [id]);
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, before)
       values ($1, 'user', $2, 'price_list.deleted', 'price_list', $3, $4)`,
      [ctx.orgId, ctx.userId, id, JSON.stringify({ name: list.rows[0].name, customers: moved.rowCount })],
    );
    return { customers: moved.rowCount ?? 0 };
  });
}

/** Puts a customer on a price list, or back on list prices with null. */
export async function setCustomerPriceList(ctx: Ctx, customerId: string, priceListId: string | null): Promise<void> {
  requirePermission(ctx, "customer.write");
  if (!UUID.test(customerId)) throw new StateError("Customer not found.");
  if (priceListId !== null && !UUID.test(priceListId)) throw new ValidationError("priceListId", "Choose a price list.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    if (priceListId) {
      const list = await tx.query("select 1 from price_lists where id = $1", [priceListId]);
      if (!list.rowCount) throw new ValidationError("priceListId", "Choose a price list.");
    }
    const updated = await tx.query("update customers set price_list_id = $2, updated_at = now() where id = $1", [
      customerId,
      priceListId,
    ]);
    if (!updated.rowCount) throw new StateError("Customer not found.");
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
       values ($1, 'user', $2, 'customer.price_list_changed', 'customer', $3, $4)`,
      [ctx.orgId, ctx.userId, customerId, JSON.stringify({ priceListId })],
    );
  });
}
