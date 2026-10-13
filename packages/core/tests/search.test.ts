import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import { createCustomer, createExpense, createProduct, createQuote, listCustomers, listProducts, saveContact, search, likeness, setCustomerArchived, type Ctx, type Role } from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
const as = (role: Role, features?: Ctx["features"]): Ctx => ({ pool: app, orgId, userId, role, features });
const kinds = async (ctx: Ctx, q: string) => (await search(ctx, q)).map((g) => g.kind);
const titles = async (ctx: Ctx, q: string, kind: string) => (await search(ctx, q)).find((g) => g.kind === kind)?.hits.map((h) => h.title) ?? [];

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  await owner.query("drop schema public cascade; create schema public;");
  await migrate(owner);
  ({ orgId, userId } = await seed(owner));
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

describe("search", () => {
  it("finds customers by name or by a contact, products by name, code or barcode, and orders by number", async () => {
    const c = await createCustomer(as("owner"), { name: "Zephyr Marine Supply" });
    await saveContact(as("owner"), c.id, { name: "Odalys Quintero", email: "odalys@zephyr.example" });
    await createProduct(as("owner"), { sku: "ZX-900", name: "Bilge pump", price: 80, barcode: "5012345678900" });
    expect(await titles(as("owner"), "zephyr", "customers")).toEqual(["Zephyr Marine Supply"]);
    const byContact = (await search(as("owner"), "odalys")).find((g) => g.kind === "customers")!;
    expect(byContact.hits[0]).toMatchObject({ title: "Zephyr Marine Supply", href: `/customers/${c.id}` });
    expect(byContact.hits[0]!.detail).toContain("Odalys Quintero");
    expect(await titles(as("owner"), "bilge", "products")).toEqual(["Bilge pump"]);
    expect(await titles(as("owner"), "zx-9", "products")).toEqual(["Bilge pump"]);
    expect(await titles(as("owner"), "50123456789", "products")).toEqual(["Bilge pump"]);
    const product = (await listProducts(as("owner"))).find((p) => p.available >= 2)!;
    const order = await createQuote(as("sales"), { customerId: c.id, lines: [{ productId: product.id, qty: 1 }] });
    const hit = (await search(as("owner"), order.number)).find((g) => g.kind === "orders")!.hits[0]!;
    expect(hit).toMatchObject({ title: order.number, href: `/sales/${order.id}` });
    expect(hit.detail).toContain("Zephyr Marine Supply");
    // The customer's name finds their orders too.
    expect(await titles(as("owner"), "zephyr", "orders")).toContain(order.number);
  });

  it("ignores very short text and treats % and _ as ordinary characters", async () => {
    expect(await search(as("owner"), " a ")).toEqual([]);
    expect(await search(as("owner"), "%%")).toEqual([]);
    expect(await search(as("owner"), "__")).toEqual([]);
    await createCustomer(as("owner"), { name: "100% Cotton_Co" });
    expect(await titles(as("owner"), "100%", "customers")).toEqual(["100% Cotton_Co"]);
    expect(await titles(as("owner"), "n_c", "customers")).toEqual(["100% Cotton_Co"]);
    expect(await search(as("owner"), "'; drop table customers; --")).toEqual([]);
    expect((await listCustomers(as("owner"))).length).toBeGreaterThan(0);
  });

  it("shows at most six of each kind, says when there are more, and lists archived records last", async () => {
    for (let i = 1; i <= 8; i++) await createCustomer(as("owner"), { name: `Quillon Branch ${i}` });
    const first = (await listCustomers(as("owner"))).find((c) => c.name === "Quillon Branch 1")!;
    await setCustomerArchived(as("owner"), first.id, true);
    const group = (await search(as("owner"), "quillon")).find((g) => g.kind === "customers")!;
    expect(group.hits).toHaveLength(6);
    expect(group.more).toBe(true);
    expect(group.hits.map((h) => h.title)).not.toContain("Quillon Branch 1");
  });

  it("only searches what the role may see", async () => {
    await createExpense(as("owner"), { description: "Harbor rent October", category: "Rent", amount: 900, incurredOn: "2026-10-01" });
    expect(await kinds(as("owner"), "harbor")).toContain("bills");
    expect(await kinds(as("sales"), "harbor")).not.toContain("bills");
    expect(await kinds(as("owner", { expenses: false }), "harbor")).not.toContain("bills");
    // Warehouse staff see products and orders, not customers, invoices' customers via the customer group, or suppliers' bills.
    const warehouse = await kinds(as("warehouse"), "zephyr");
    expect(warehouse).not.toContain("customers");
    expect(warehouse).toContain("orders");
    expect(await kinds(as("sales"), "summit")).not.toContain("suppliers");
    expect(await kinds(as("owner"), "summit")).toContain("suppliers");
    expect(await kinds(as("owner", { purchasing: false }), "summit")).not.toContain("suppliers");
  });

  it("never returns another company's records", async () => {
    const other = await owner.query<{ id: string }>("insert into organizations (name, slug) values ('Other', 'other-search') returning id");
    const there: Ctx = { pool: app, orgId: other.rows[0]!.id, userId, role: "owner" };
    expect(await search(there, "zephyr")).toEqual([]);
    expect(await search(there, "SO-")).toEqual([]);
  });

  it("offers near misses when nothing matches as typed, and only then", async () => {
    await createCustomer(as("owner"), { name: "Fairweather Chandlery" });
    await createProduct(as("owner"), { sku: "AN-22", name: "Galvanised anchor", price: 60 });
    const typo = await search(as("owner"), "fairwether chandlry");
    expect(typo.find((g) => g.kind === "customers")).toMatchObject({ close: true });
    expect(typo.find((g) => g.kind === "customers")!.hits[0]!.title).toBe("Fairweather Chandlery");
    expect((await search(as("owner"), "galvanized ancor")).find((g) => g.kind === "products")!.hits[0]!.title).toContain("Galvanised anchor");
    // An exact match is never mixed with guesses.
    expect((await search(as("owner"), "fairweather")).every((g) => !g.close)).toBe(true);
    // Nonsense finds nothing, and short text is not guessed at.
    expect(await search(as("owner"), "qqqqzzzzxxxx")).toEqual([]);
    expect(await search(as("owner"), "zqx")).toEqual([]);
    // Near misses respect roles too.
    expect((await search(as("warehouse"), "fairwether chandlry")).some((g) => g.kind === "customers")).toBe(false);
    expect(likeness("bayside", "Bayside Hardware")).toBeGreaterThan(0.9);
    expect(likeness("hammer", "Potting soil")).toBeLessThan(0.2);
  });
});
