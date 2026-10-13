import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  ForbiddenError, getCustomer, importTemplate, listCustomers, listProducts, parseCsv, planImport, reconcileStock, runImport, ValidationError,
  type Ctx, type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
const as = (role: Role, features?: Ctx["features"]): Ctx => ({ pool: app, orgId, userId, role, features });

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

describe("reading a spreadsheet file", () => {
  it("handles quotes, commas and line breaks inside cells, blank lines and a byte-order mark", () => {
    expect(parseCsv('﻿Name,Address\r\n"Smith, Jones & Co","1 Main St\nSuite 2"\r\n\r\n"He said ""hi""",x\n')).toEqual([
      ["Name", "Address"],
      ["Smith, Jones & Co", "1 Main St\nSuite 2"],
      ['He said "hi"', "x"],
    ]);
  });
  it("reads tab and semicolon files too", () => {
    expect(parseCsv("Code\tName\nA1\tWidget, large")).toEqual([["Code", "Name"], ["A1", "Widget, large"]]);
    expect(parseCsv("Code;Name\nA1;Widget")).toEqual([["Code", "Name"], ["A1", "Widget"]]);
  });
  it("gives a template that imports cleanly", async () => {
    const plan = await planImport(as("owner"), "products", importTemplate("products").replace("GL-WK-L", "TEMPLATE-1").replace("036000291452", "99887766"));
    expect(plan.errors).toBe(0);
    expect(plan.headings.every((h) => h.column !== null)).toBe(true);
  });
});

describe("importing customers", () => {
  const file = [
    "Company,Terms,Bill To,Email,Phone,Notes",
    "Northwind Marine,Net 30,\"4 Dock St, Bath, ME\",pat@northwind.example,207-555-0101,vip",
    "northwind marine,Net 15,,,,",
    ",Net 30,,,,",
    "Bad Email Co,,,not-an-email,,",
    "Quiet Co,,,,,",
  ].join("\n");

  it("says what would happen without changing anything", async () => {
    const before = (await listCustomers(as("owner"))).length;
    const plan = await planImport(as("sales"), "customers", file);
    expect(plan.rows.map((r) => r.action)).toEqual(["add", "skip", "error", "error", "add"]);
    expect([plan.add, plan.skip, plan.errors]).toEqual([2, 1, 2]);
    expect(plan.headings.find((h) => h.heading === "Notes")!.column).toBeNull();
    expect(plan.notes.join(" ")).toContain("Notes");
    expect(plan.rows[3]!.note).toContain("not-an-email");
    expect((await listCustomers(as("owner"))).length).toBe(before);
  });

  it("adds the good rows with their address and contact, and skips them the second time", async () => {
    const done = await runImport(as("sales"), "customers", file, randomUUID());
    expect(done.add).toBe(2);
    const added = (await listCustomers(as("owner"))).find((c) => c.name === "Northwind Marine")!;
    const detail = (await getCustomer(as("owner"), added.id))!;
    expect(detail.paymentTerms).toBe("Net 30");
    expect(detail.contacts).toHaveLength(1);
    expect(detail.contacts[0]).toMatchObject({ email: "pat@northwind.example", phone: "207-555-0101", isPrimary: true });
    const row = await owner.query("select billing_address from customers where id = $1", [added.id]);
    expect(row.rows[0].billing_address).toBe("4 Dock St, Bath, ME");
    const again = await runImport(as("sales"), "customers", file, randomUUID());
    expect([again.add, again.skip]).toEqual([0, 3]);
    expect((await listCustomers(as("owner"))).filter((c) => c.name.toLowerCase() === "northwind marine")).toHaveLength(1);
  });
});

describe("importing products", () => {
  const file = [
    "SKU,Product Name,Category,Price,Cost,UPC,Bin,Reorder Level,Qty",
    'IMP-1,"Rope, 50 ft",Marine,"$1,250.50",700,4006381333931,B-2,5,12',
    "IMP-2,Anchor,Marine,89,40,,,,0",
    "imp-1,Duplicate code,,,,,,,",
    "IMP-3,Bad price,,abc,,,,,",
    "IMP-4,Same barcode,,5,,4006381333931,,,",
    "IMP-5,Negative stock,,5,,,,,-3",
    "IMP-6,,,5,,,,,",
  ].join("\n");

  it("checks every row and adds nothing while planning", async () => {
    const plan = await planImport(as("owner"), "products", file);
    expect(plan.rows.map((r) => r.action)).toEqual(["add", "add", "skip", "error", "error", "error", "error"]);
    expect(plan.rows[0]!.note).toContain("Opening stock 12");
    expect((await listProducts(as("owner"))).some((p) => p.sku === "IMP-1")).toBe(false);
  });

  it("adds products with their opening stock through the stock ledger", async () => {
    const key = randomUUID();
    await runImport(as("owner"), "products", file, key);
    const products = await listProducts(as("owner"));
    const rope = products.find((p) => p.sku === "IMP-1")!;
    expect(rope).toMatchObject({ name: "Rope, 50 ft", category: "Marine", price: 1250.5, cost: 700, onHand: 12, available: 12 });
    expect(products.find((p) => p.sku === "IMP-2")!.onHand).toBe(0);
    expect(await reconcileStock(as("owner"))).toEqual([]);
    const moves = await owner.query("select qty_delta::float8 as q, reason from stock_movements where product_id = $1", [rope.id]);
    expect(moves.rows).toEqual([{ q: 12, reason: "Opening stock from import" }]);
    // Importing the same file again adds nothing and posts no more stock.
    const again = await runImport(as("owner"), "products", file, randomUUID());
    expect(again.add).toBe(0);
    expect((await listProducts(as("owner"))).find((p) => p.sku === "IMP-1")!.onHand).toBe(12);
  });

  it("imports nothing at all when something fails part way", async () => {
    const before = (await listProducts(as("owner"))).length;
    // A failure the plan cannot foresee, forced on the second row.
    const text = "Code,Name,Barcode\nATOM-1,First,\nATOM-2,Second,";
    await owner.query("create or replace function test_fail() returns trigger language plpgsql as $$ begin if new.sku = 'ATOM-2' then raise exception 'boom'; end if; return new; end $$");
    await owner.query("create trigger test_fail before insert on products for each row execute function test_fail()");
    await expect(runImport(as("owner"), "products", text, randomUUID())).rejects.toThrow("boom");
    await owner.query("drop trigger test_fail on products");
    expect((await listProducts(as("owner"))).length).toBe(before);
  });

  it("leaves out cost and stock the role may not set, and says so", async () => {
    const text = "Code,Name,Price,Cost,On hand\nROLE-1,Sales made this,10,6,40";
    const plan = await planImport(as("sales", { stock: true }), "products", text).catch((e) => e);
    expect(plan).toBeInstanceOf(ForbiddenError); // sales cannot add products at all
    const lean = await runImport(as("owner", { stock: false }), "products", text, randomUUID());
    expect(lean.notes.join(" ")).toContain("On hand");
    const made = (await listProducts(as("owner"))).find((p) => p.sku === "ROLE-1")!;
    expect(made.onHand).toBe(0);
    expect(made.cost).toBe(6);
  });

  it("rejects files with no usable headings, too many rows or no rows", async () => {
    await expect(planImport(as("owner"), "products", "Foo,Bar\n1,2")).rejects.toBeInstanceOf(ValidationError);
    await expect(planImport(as("owner"), "products", "Code,Name")).rejects.toBeInstanceOf(ValidationError);
    const big = "Code,Name\n" + Array.from({ length: 2001 }, (_, i) => `B${i},Item ${i}`).join("\n");
    await expect(planImport(as("owner"), "products", big)).rejects.toThrow("2000");
    await expect(planImport(as("viewer"), "customers", "Name\nX")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keeps an import inside its own company", async () => {
    const other = await owner.query<{ id: string }>("insert into organizations (name, slug) values ('Other', 'other-import') returning id");
    const there: Ctx = { pool: app, orgId: other.rows[0]!.id, userId, role: "owner", features: { stock: false } };
    const plan = await runImport(there, "products", "Code,Name\nIMP-1,Their own rope", randomUUID());
    expect(plan.add).toBe(1); // IMP-1 exists in the first company, which must not block or be touched
    expect((await listProducts(as("owner"))).filter((p) => p.sku === "IMP-1")).toHaveLength(1);
    expect((await listProducts(as("owner"))).find((p) => p.sku === "IMP-1")!.name).toBe("Rope, 50 ft");
  });
});
