import type { Pool, PoolClient } from "./client";

export const DEMO_ORG_SLUG = "harbor-supply";

const people = [
  { email: "amara@harborsupply.example", name: "Amara Okafor", role: "owner" },
  { email: "luis@harborsupply.example", name: "Luis Delgado", role: "sales" },
  { email: "priya@harborsupply.example", name: "Priya Raman", role: "warehouse" },
] as const;

const customers = [
  {
    name: "Bayside Hardware",
    terms: "Net 30",
    contacts: [{ name: "Marcus Bell", title: "Owner", email: "marcus@bayside.example", phone: "555-0101" }],
  },
  {
    name: "Delgado Restaurant Supply",
    terms: "Net 15",
    contacts: [{ name: "Elena Delgado", title: "Buyer", email: "elena@delgadosupply.example", phone: "555-0102" }],
  },
  {
    name: "Kim & Sons Market",
    terms: "Net 30",
    contacts: [{ name: "Daniel Kim", title: "Manager", email: "daniel@kimandsons.example", phone: "555-0103" }],
  },
  {
    name: "Tanaka Garden Center",
    terms: "Due on receipt",
    contacts: [{ name: "Yuki Tanaka", title: "Owner", email: "yuki@tanakagarden.example", phone: "555-0104" }],
  },
] as const;

const products = [
  ["FS-DS3-100", "Deck screws 3 in, box of 100", "Fasteners", "A-02-1", 5.1, 8.5, 60],
  ["GL-WK-L", "Work gloves, large, pair", "Safety", "A-03-2", 2.4, 4.25, 80],
  ["PL-CEM-16", "PVC pipe cement 16 oz", "Plumbing", "A-14-2", 4.05, 6.8, 36],
  ["TL-UKB-50", "Utility knife blades, 50 pack", "Tools", "A-09-4", 6.6, 11, 24],
  ["GD-HOSE-50", "Garden hose 50 ft, heavy duty", "Garden", "B-07-3", 14.2, 24, 12],
  ["GD-NOZ-BR", "Hose nozzle, brass", "Garden", "B-11-1", 3.9, 7.5, 24],
  ["GD-SOIL-20", "Potting soil 20 lb", "Garden", "C-02-4", 4.8, 8.75, 30],
] as const;

/** Opening stock per SKU. Two products start below their reorder point. */
const openingStock: Record<string, number> = {
  "FS-DS3-100": 212,
  "GL-WK-L": 340,
  "PL-CEM-16": 18,
  "TL-UKB-50": 64,
  "GD-HOSE-50": 31,
  "GD-NOZ-BR": 20,
  "GD-SOIL-20": 85,
};

/** Posts opening balances the same way the ledger does: a movement and its balance change together. */
async function seedStock(client: PoolClient, orgId: string, ownerId: string): Promise<void> {
  let location = await client.query<{ id: string }>("select id from locations where org_id = $1 limit 1", [orgId]);
  if (location.rowCount === 0) {
    location = await client.query<{ id: string }>(
      "insert into locations (org_id, name) values ($1, 'Main warehouse') returning id",
      [orgId],
    );
  }
  const locationId = location.rows[0]!.id;
  for (const [sku, qty] of Object.entries(openingStock)) {
    const posted = await client.query<{ product_id: string }>(
      `insert into stock_movements (org_id, product_id, location_id, qty_delta, unit_cost, kind, reason, idempotency_key, posted_by)
       select p.org_id, p.id, $2, $3, p.cost, 'opening_balance', 'Opening balance', 'seed:opening:' || p.sku, $4
       from products p where p.org_id = $1 and p.sku = $5
       on conflict (org_id, idempotency_key) do nothing
       returning product_id`,
      [orgId, locationId, qty, ownerId, sku],
    );
    if (posted.rowCount === 1) {
      await client.query(
        `insert into stock_levels (org_id, product_id, location_id, on_hand) values ($1, $2, $3, $4)
         on conflict (org_id, product_id, location_id) do update set on_hand = stock_levels.on_hand + excluded.on_hand`,
        [orgId, posted.rows[0]!.product_id, locationId, qty],
      );
    }
  }
}

async function seedMasterData(client: PoolClient, orgId: string, ownerId: string): Promise<void> {
  const existing = await client.query("select 1 from customers where org_id = $1 limit 1", [orgId]);
  if (existing.rowCount === 0) {
    for (const customer of customers) {
      const row = await client.query<{ id: string }>(
        "insert into customers (org_id, name, payment_terms, owner_user_id) values ($1, $2, $3, $4) returning id",
        [orgId, customer.name, customer.terms, ownerId],
      );
      for (const contact of customer.contacts) {
        await client.query(
          `insert into contacts (org_id, customer_id, name, title, email, phone, is_primary)
           values ($1, $2, $3, $4, $5, $6, true)`,
          [orgId, row.rows[0]!.id, contact.name, contact.title, contact.email, contact.phone],
        );
      }
    }
  }
  for (const [sku, name, category, shelf, cost, price, reorder] of products) {
    await client.query(
      `insert into products (org_id, sku, name, category, shelf_location, cost, price, reorder_point)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (org_id, sku) do nothing`,
      [orgId, sku, name, category, shelf, cost, price, reorder],
    );
  }
}

/** Loads one demo company with people, customers and products. Safe to run repeatedly. Runs as the owner role. */
export async function seed(owner: Pool): Promise<{ orgId: string; userId: string }> {
  const client = await owner.connect();
  try {
    await client.query("begin");
    const org = await client.query<{ id: string }>(
      `insert into organizations (name, slug) values ('Harbor Supply Co.', $1)
       on conflict (slug) do update set name = excluded.name
       returning id`,
      [DEMO_ORG_SLUG],
    );
    const orgId = org.rows[0]!.id;
    let ownerId = "";
    let created = false;
    for (const person of people) {
      const user = await client.query<{ id: string }>(
        `insert into users (email, name) values ($1, $2)
         on conflict (email) do update set name = excluded.name
         returning id`,
        [person.email, person.name],
      );
      const userId = user.rows[0]!.id;
      if (person.role === "owner") ownerId = userId;
      const membership = await client.query(
        `insert into memberships (org_id, user_id, role) values ($1, $2, $3)
         on conflict (org_id, user_id) do nothing`,
        [orgId, userId, person.role],
      );
      if (membership.rowCount === 1 && person.role === "owner") created = true;
    }
    if (created) {
      await client.query(
        `insert into audit_log (org_id, actor_type, action, entity_type, entity_id, after)
         values ($1, 'system', 'seed.created', 'organization', $1, $2)`,
        [orgId, JSON.stringify({ slug: DEMO_ORG_SLUG })],
      );
    }
    await seedMasterData(client, orgId, ownerId);
    await seedStock(client, orgId, ownerId);
    await client.query("commit");
    return { orgId, userId: ownerId };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
