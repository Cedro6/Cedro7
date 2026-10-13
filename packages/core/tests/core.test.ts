import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  can,
  createCustomer,
  currentMembership,
  ForbiddenError,
  getCustomer,
  listCustomers,
  listProducts,
  membershipsByEmail,
  overview,
  PERMISSIONS,
  ROLES,
  ValidationError,
  type Ctx,
  type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
let otherOrgId: string;

const as = (role: Role): Ctx => ({ pool: app, orgId, userId, role });

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  await owner.query("drop schema public cascade; create schema public;");
  await migrate(owner);
  ({ orgId, userId } = await seed(owner));
  const other = await owner.query<{ id: string }>(
    "insert into organizations (name, slug) values ('Other Co', 'other-co') returning id",
  );
  otherOrgId = other.rows[0]!.id;
  await owner.query("insert into customers (org_id, name) values ($1, 'Secret Customer')", [otherOrgId]);
  await owner.query("insert into products (org_id, sku, name) values ($1, 'X-1', 'Secret Product')", [otherOrgId]);
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe("permission matrix", () => {
  it("owner and admin hold every permission", () => {
    for (const permission of PERMISSIONS) {
      expect(can("owner", permission)).toBe(true);
      expect(can("admin", permission)).toBe(true);
    }
  });

it("matches the documented table for the other roles", () => {
    const allowed = Object.fromEntries(ROLES.map((role) => [role, PERMISSIONS.filter((p) => can(role, p))]));
    expect(allowed.sales).toEqual([
      "customer.read",
      "customer.write",
      "product.read",
      "stock.reserve",
      "sales_order.read",
      "sales_order.write",
      "report.view",
      "vehicle.read",
      "vehicle.write",
    ]);
    expect(allowed.purchasing).toEqual([
      "customer.read",
      "product.read",
      "product.write",
      "product.cost.view",
      "stock.adjust",
      "sales_order.read",
      "purchase_order.read",
      "purchase_order.write",
      "purchase_order.receive",
      "report.view",
      "expense.read",
      "expense.write",
      "vehicle.read",
      "vehicle.write",
    ]);
    expect(allowed.warehouse).toEqual([
      "product.read",
      "stock.adjust",
      "sales_order.read",
      "sales_order.ship",
      "purchase_order.read",
      "purchase_order.receive",
      "vehicle.read",
    ]);
    expect(allowed.viewer).toEqual([
      "customer.read",
      "product.read",
      "sales_order.read",
      "purchase_order.read",
      "report.view",
      "vehicle.read",
    ]);
  });
});

describe("sign-in lookup", () => {
  it("finds a person's memberships by email, ignoring case", async () => {
    const found = await membershipsByEmail(app, "AMARA@harborsupply.example");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ orgId, userId, role: "owner", orgName: "Harbor Supply Co." });
  });

  it("returns nothing for an unknown email", async () => {
    expect(await membershipsByEmail(app, "nobody@nowhere.example")).toEqual([]);
  });

  it("stops recognising a suspended member", async () => {
    const luis = (await membershipsByEmail(app, "luis@harborsupply.example"))[0]!;
    expect(await currentMembership(app, orgId, luis.userId)).toMatchObject({ role: "sales" });
    await owner.query("update memberships set status = 'suspended' where user_id = $1", [luis.userId]);
    expect(await currentMembership(app, orgId, luis.userId)).toBeNull();
    expect(await membershipsByEmail(app, "luis@harborsupply.example")).toEqual([]);
    await owner.query("update memberships set status = 'active' where user_id = $1", [luis.userId]);
  });

  it("does not accept a membership in a company the person does not belong to", async () => {
    expect(await currentMembership(app, otherOrgId, userId)).toBeNull();
  });
});

describe("customers", () => {
  it("lists only this company's customers", async () => {
    const names = (await listCustomers(as("owner"))).map((c) => c.name);
    expect(names).toEqual([
      "Bayside Hardware",
      "Delgado Restaurant Supply",
      "Kim & Sons Market",
      "Tanaka Garden Center",
    ]);
  });

  it("searches by name", async () => {
    const found = await listCustomers(as("sales"), { search: "garden" });
    expect(found.map((c) => c.name)).toEqual(["Tanaka Garden Center"]);
  });

  it("returns a customer with its contacts, and null for another company's id", async () => {
    const first = (await listCustomers(as("owner")))[0]!;
    const detail = await getCustomer(as("owner"), first.id);
    expect(detail?.contacts.map((c) => c.name)).toEqual(["Marcus Bell"]);
    const secret = await owner.query<{ id: string }>("select id from customers where org_id = $1", [otherOrgId]);
    expect(await getCustomer(as("owner"), secret.rows[0]!.id)).toBeNull();
    expect(await getCustomer(as("owner"), "not-an-id")).toBeNull();
  });

  it("refuses roles without access", async () => {
    await expect(listCustomers(as("warehouse"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createCustomer(as("viewer"), { name: "X" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createCustomer(as("purchasing"), { name: "X" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("creates a customer and records it in the audit log", async () => {
    const { id } = await createCustomer(as("sales"), { name: "  Pine Street Cafe ", paymentTerms: "Net 15" });
    const detail = await getCustomer(as("sales"), id);
    expect(detail).toMatchObject({ name: "Pine Street Cafe", paymentTerms: "Net 15", ownerName: "Amara Okafor" });
    const audit = await owner.query(
      "select actor_type, actor_id, action from audit_log where entity_id = $1 and org_id = $2",
      [id, orgId],
    );
    expect(audit.rows).toEqual([{ actor_type: "user", actor_id: userId, action: "customer.created" }]);
  });

  it("rejects an empty name without writing anything", async () => {
    const before = (await listCustomers(as("owner"))).length;
    await expect(createCustomer(as("owner"), { name: "   " })).rejects.toBeInstanceOf(ValidationError);
    expect((await listCustomers(as("owner"))).length).toBe(before);
  });
});

describe("products", () => {
  it("lists this company's products with cost for roles allowed to see it", async () => {
    const products = await listProducts(as("purchasing"));
    expect(products).toHaveLength(7);
    expect(products[0]).toMatchObject({
      sku: "FS-DS3-100",
      price: 8.5,
      cost: 5.1,
      onHand: 212,
      reserved: 0,
      available: 212,
      onOrder: 0,
      lowStock: false,
    });
    expect(products.filter((p) => p.lowStock).map((p) => p.sku)).toEqual(["GD-NOZ-BR", "PL-CEM-16"]);
  });

  it("hides cost from sales, warehouse and viewer", async () => {
    for (const role of ["sales", "warehouse", "viewer"] as const) {
      const products = await listProducts(as(role));
      expect(products.every((p) => p.cost === null), role).toBe(true);
    }
  });

  it("searches by SKU or name", async () => {
    expect((await listProducts(as("owner"), { search: "gd-" })).map((p) => p.sku)).toEqual([
      "GD-HOSE-50",
      "GD-NOZ-BR",
      "GD-SOIL-20",
    ]);
  });
});

describe("overview", () => {
  it("counts this company only and hides what the role may not see", async () => {
    const full = await overview(as("owner"));
    expect(full).toEqual({ customers: 5, products: 7, team: 3, lowStock: 2, openOrders: 0, readyToShip: 0, openPurchaseOrders: 0, overdueInvoices: 0 });
    expect((await overview(as("warehouse"))).customers).toBeNull();
  });
});
