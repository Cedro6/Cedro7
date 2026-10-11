import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  confirmOrder, createProduct, createQuote, createSupplier, ForbiddenError, getCustomer, getProduct, getSupplier,
  listArchivedCustomers, listArchivedProducts, listCustomers, listProducts, listSuppliers, removeContact, saveContact,
  setCustomerArchived, setProductArchived, setSupplierArchived, updateCustomer, updateProduct, updateSupplier,
  ValidationError, type Ctx, type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
const as = (role: Role): Ctx => ({ pool: app, orgId, userId, role });

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

describe("customers", () => {
  it("edits a customer and keeps one primary contact", async () => {
    const c = (await listCustomers(as("owner")))[0]!;
    await updateCustomer(as("sales"), c.id, { name: "Renamed Co", paymentTerms: "Net 15" });
    const a = await saveContact(as("sales"), c.id, { name: "Ann", email: "ann@example.com", isPrimary: true });
    const b = await saveContact(as("sales"), c.id, { name: "Bob", isPrimary: true });
    const got = (await getCustomer(as("owner"), c.id))!;
    expect(got.name).toBe("Renamed Co");
    expect(got.paymentTerms).toBe("Net 15");
    expect(got.contacts.filter((k) => k.isPrimary).map((k) => k.id)).toEqual([b.id]);
    await saveContact(as("sales"), c.id, { name: "Ann Lee", title: "Buyer" }, a.id);
    await removeContact(as("sales"), c.id, b.id);
    const after = (await getCustomer(as("owner"), c.id))!;
    expect(after.contacts.find((k) => k.id === a.id)?.name).toBe("Ann Lee");
    expect(after.contacts.some((k) => k.id === b.id)).toBe(false);
  });

  it("rejects a bad email and a role that cannot edit customers", async () => {
    const c = (await listCustomers(as("owner")))[0]!;
    await expect(saveContact(as("sales"), c.id, { name: "X", email: "nope" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateCustomer(as("warehouse"), c.id, { name: "Hack" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("will not archive a customer with open orders, and restores an archived one", async () => {
    const customers = await listCustomers(as("owner"));
    const product = (await listProducts(as("owner")))[0]!;
    const busy = customers[1]!;
    const quote = await createQuote(as("sales"), { customerId: busy.id, lines: [{ productId: product.id, qty: 1, unitPrice: 5 }] });
    await confirmOrder(as("sales"), quote.id);
    await expect(setCustomerArchived(as("owner"), busy.id, true)).rejects.toThrow(/open orders/);
    const idle = (await owner.query<{ id: string }>("insert into customers (org_id, name) values ($1, 'Idle Co') returning id", [orgId])).rows[0]!.id;
    await setCustomerArchived(as("owner"), idle, true);
    expect((await listCustomers(as("owner"))).some((c) => c.id === idle)).toBe(false);
    expect((await listArchivedCustomers(as("owner"))).some((c) => c.id === idle)).toBe(true);
    await setCustomerArchived(as("owner"), idle, false);
    expect((await listCustomers(as("owner"))).some((c) => c.id === idle)).toBe(true);
  });
});

describe("products", () => {
  it("creates, edits and archives a product, and refuses a duplicate code", async () => {
    const { id } = await createProduct(as("owner"), { sku: "NEW-1", name: "New thing", price: 12.5, cost: 7, reorderPoint: 4 });
    await expect(createProduct(as("owner"), { sku: "NEW-1", name: "Copy", price: 1 })).rejects.toThrow(/already uses/);
    await updateProduct(as("owner"), id, { sku: "NEW-1", name: "New thing v2", price: 14, cost: 8 });
    const p = (await getProduct(as("owner"), id))!;
    expect([p.name, p.price, p.cost, p.reorderPoint]).toEqual(["New thing v2", 14, 8, null]);
    await setProductArchived(as("owner"), id, true);
    expect((await listProducts(as("owner"))).some((x) => x.id === id)).toBe(false);
    expect((await listArchivedProducts(as("owner"))).some((x) => x.id === id)).toBe(true);
  });

  it("does not let sales create products or change a price below zero", async () => {
    await expect(createProduct(as("sales"), { sku: "S-1", name: "S", price: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createProduct(as("owner"), { sku: "S-2", name: "S", price: -1 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("will not archive a product reserved for an open order", async () => {
    const reserved = await owner.query<{ product_id: string }>("select product_id from stock_levels where reserved > 0 limit 1");
    if (reserved.rowCount) await expect(setProductArchived(as("owner"), reserved.rows[0]!.product_id, true)).rejects.toThrow(/reserved/);
  });
});

describe("suppliers", () => {
  it("edits, archives and restores a supplier", async () => {
    const { id } = await createSupplier(as("owner"), { name: "Acme Supply" });
    await updateSupplier(as("owner"), id, { name: "Acme Supply Co", email: "a@acme.test", leadTimeDays: 9 });
    expect(await getSupplier(as("owner"), id)).toMatchObject({ name: "Acme Supply Co", leadTimeDays: 9, status: "active" });
    await setSupplierArchived(as("owner"), id, true);
    expect((await listSuppliers(as("owner"))).some((s) => s.id === id)).toBe(false);
    await setSupplierArchived(as("owner"), id, false);
    expect((await listSuppliers(as("owner"))).some((s) => s.id === id)).toBe(true);
    await expect(updateSupplier(as("sales"), id, { name: "x" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
