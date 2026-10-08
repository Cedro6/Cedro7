import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, DEMO_ORG_SLUG, health, migrate, ownerUrl, seed, withTenant, type Pool } from "../src/index";

let owner: Pool;
let app: Pool;
let orgA: string;
let orgB: string;

async function makeOrg(slug: string): Promise<string> {
  const org = await owner.query<{ id: string }>("insert into organizations (name, slug) values ($1, $2) returning id", [
    `Company ${slug}`,
    slug,
  ]);
  const user = await owner.query<{ id: string }>("insert into users (email, name) values ($1, $2) returning id", [
    `owner@${slug}.example`,
    `Owner of ${slug}`,
  ]);
  await owner.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [
    org.rows[0]!.id,
    user.rows[0]!.id,
  ]);
  return org.rows[0]!.id;
}

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  // Start from an empty database every run.
  await owner.query("drop schema public cascade; create schema public;");
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("migrations", () => {
  it("apply to an empty database", async () => {
    const applied = await migrate(owner);
    expect(applied).toEqual(["0001_platform.sql", "0002_master_data.sql", "0003_stock.sql", "0004_sales.sql", "0005_purchasing.sql",
      "0006_explicit_grants.sql",
    ]);
  });

  it("do nothing when run again", async () => {
    expect(await migrate(owner)).toEqual([]);
  });
});

describe("seed", () => {
  it("loads the demo company and is repeatable", async () => {
    const first = await seed(owner);
    const second = await seed(owner);
    expect(second).toEqual(first);
    const orgs = await owner.query("select 1 from organizations where slug = $1", [DEMO_ORG_SLUG]);
    expect(orgs.rowCount).toBe(1);
    const members = await owner.query<{ role: string }>(
      "select role from memberships where org_id = $1 order by role",
      [first.orgId],
    );
    expect(members.rows.map((r) => r.role)).toEqual(["owner", "sales", "warehouse"]);
    const counts = await owner.query<{ customers: number; contacts: number; products: number }>(
      `select (select count(*)::int from customers where org_id = $1) as customers,
              (select count(*)::int from contacts where org_id = $1) as contacts,
              (select count(*)::int from products where org_id = $1) as products`,
      [first.orgId],
    );
    expect(counts.rows[0]).toEqual({ customers: 4, contacts: 4, products: 7 });
  });
});

describe("tenant isolation", () => {
  beforeAll(async () => {
    orgA = await makeOrg("alpha-co");
    orgB = await makeOrg("bravo-co");
  });

  it("the app role is not an owner, superuser or RLS bypasser", async () => {
    const role = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolsuper, rolbypassrls from pg_roles where rolname = 'bos_app'",
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await owner.query(
      "select tablename from pg_tables where schemaname = 'public' and tableowner = 'bos_app'",
    );
    expect(owned.rows).toEqual([]);
  });

  it("every table has row-level security enabled, except the migration ledger", async () => {
    const open = await owner.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
         and c.relname <> 'schema_migrations'`,
    );
    expect(open.rows).toEqual([]);
  });

  it("without a company context the app role sees nothing", async () => {
    for (const table of ["organizations", "memberships", "users", "audit_log", "customers", "contacts", "products", "locations", "stock_levels", "stock_movements", "stock_reservations", "sales_orders", "sales_order_lines", "shipments", "shipment_lines", "document_counters", "suppliers", "purchase_orders", "purchase_order_lines", "receipts", "receipt_lines"]) {
      const rows = await app.query(`select 1 from ${table}`);
      expect(rows.rowCount, table).toBe(0);
    }
  });

  it("a company sees only its own rows", async () => {
    const seen = await withTenant(app, orgA, async (tx) => ({
      orgs: (await tx.query<{ id: string }>("select id from organizations")).rows.map((r) => r.id),
      memberOrgs: (await tx.query<{ org_id: string }>("select distinct org_id from memberships")).rows.map(
        (r) => r.org_id,
      ),
      emails: (await tx.query<{ email: string }>("select email from users")).rows.map((r) => r.email),
    }));
    expect(seen.orgs).toEqual([orgA]);
    expect(seen.memberOrgs).toEqual([orgA]);
    expect(seen.emails).toEqual(["owner@alpha-co.example"]);
  });

  it("a company cannot read another company's rows by id", async () => {
    const rows = await withTenant(app, orgA, (tx) => tx.query("select 1 from organizations where id = $1", [orgB]));
    expect(rows.rowCount).toBe(0);
  });

  it("a company cannot write rows into another company", async () => {
    await expect(
      withTenant(app, orgA, (tx) =>
        tx.query(
          "insert into audit_log (org_id, actor_type, action, entity_type) values ($1, 'system', 'x', 'organization')",
          [orgB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await withTenant(app, orgA, (tx) =>
      tx.query("update organizations set name = 'Taken over' where id = $1", [orgB]),
    );
    expect(updated.rowCount).toBe(0);
  });

  it("the company context does not leak to the next transaction on the same connection", async () => {
    const single = createPool(appUrl());
    single.options.max = 1;
    try {
      await withTenant(single, orgA, (tx) => tx.query("select 1"));
      const after = await single.query("select 1 from organizations");
      expect(after.rowCount).toBe(0);
    } finally {
      await single.end();
    }
  });

  it("rejects a company id that is not a UUID", async () => {
    await expect(withTenant(app, "1; drop table users", async () => 1)).rejects.toThrow(/UUID/);
  });
});

describe("audit log", () => {
  it("accepts inserts but refuses updates and deletes from the app role", async () => {
    await withTenant(app, orgA, (tx) =>
      tx.query(
        "insert into audit_log (org_id, actor_type, actor_id, action, entity_type) values ($1, 'user', $2, 'test.event', 'organization')",
        [orgA, randomUUID()],
      ),
    );
    await expect(withTenant(app, orgA, (tx) => tx.query("update audit_log set action = 'edited'"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(withTenant(app, orgA, (tx) => tx.query("delete from audit_log"))).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("health", () => {
  it("reports the database as reachable for the app role", async () => {
    const result = await health(app);
    expect(result.ok).toBe(true);
  });
});
