import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import {
  changeHomeLayout, confirmOrder, createQuote, dailySales, defaultHome, getHomeLayout, headline, heroFigures, listCustomers, listProducts,
  orderHeatmap, salesSeries, ValidationError, widgetAllowed, WIDGETS, type Ctx, type Role,
} from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
let otherUser: string;
const as = (role: Role, features?: Ctx["features"], user = userId): Ctx => ({ pool: app, orgId, userId: user, role, features });

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  await owner.query("drop schema public cascade; create schema public;");
  await migrate(owner);
  ({ orgId, userId } = await seed(owner));
  otherUser = (await owner.query<{ user_id: string }>("select user_id from memberships where org_id = $1 and user_id <> $2 limit 1", [orgId, userId])).rows[0]!.user_id;
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

describe("home layout", () => {
  it("starts from the business type's cards, minus any the role or features rule out", async () => {
    expect((await getHomeLayout(as("owner"), "distributor")).widgets).toEqual(defaultHome("distributor"));
    expect((await getHomeLayout(as("owner"), "warehouse")).widgets).toEqual(["tiles", "ship", "putaway", "attention", "low-stock", "today"]);
    const warehouse = await getHomeLayout(as("warehouse"), "distributor");
    expect(warehouse.widgets).not.toContain("hero"); // no reports for this role
    expect(warehouse.customized).toBe(false);
    const lean = await getHomeLayout(as("owner", { stock: false, calendar: false }), "warehouse");
    expect(lean.widgets).toEqual(["tiles", "attention"]);
    expect(lean.available).not.toEqual(expect.arrayContaining(["ship", "low-stock", "putaway", "today", "calendar"]));
  });

  it("lets a person add, move, replace and remove cards without touching anyone else's", async () => {
    const me = as("owner");
    await changeHomeLayout(me, "distributor", { kind: "add", id: "heatmap" });
    await changeHomeLayout(me, "distributor", { kind: "move", id: "heatmap", by: -1 });
    await changeHomeLayout(me, "distributor", { kind: "replace", id: "today", with: "calendar" });
    await changeHomeLayout(me, "distributor", { kind: "remove", id: "invoices" });
    const mine = await getHomeLayout(me, "distributor");
    expect(mine.widgets).toEqual(["hero", "tiles", "sales", "attention", "calendar", "heatmap", "top-products"]);
    expect(mine.customized).toBe(true);
    expect(mine.available).toEqual(expect.arrayContaining(["invoices", "today"]));
    expect((await getHomeLayout(as("owner", undefined, otherUser), "distributor")).customized).toBe(false);
    await changeHomeLayout(me, "distributor", { kind: "move", id: "hero", by: -1 }); // already first: nothing happens
    expect((await getHomeLayout(me, "distributor")).widgets[0]).toBe("hero");
    await changeHomeLayout(me, "distributor", { kind: "reset" });
    expect(await getHomeLayout(me, "distributor")).toMatchObject({ widgets: defaultHome("distributor"), customized: false });
  });

  it("refuses a card twice, an unknown card, and one the role may not have", async () => {
    await expect(changeHomeLayout(as("owner"), "distributor", { kind: "add", id: "hero" })).rejects.toThrow(/already on your Home/);
    await expect(changeHomeLayout(as("owner"), "distributor", { kind: "add", id: "bitcoin-ticker" })).rejects.toBeInstanceOf(ValidationError);
    await expect(changeHomeLayout(as("warehouse"), "distributor", { kind: "add", id: "top-customers" })).rejects.toThrow(/not available to you/);
    await expect(changeHomeLayout(as("owner"), "distributor", { kind: "remove", id: "putaway" })).rejects.toThrow(/not on your Home/);
    await changeHomeLayout(as("owner"), "distributor", { kind: "reset" });
  });

  it("drops a saved card the person later loses the right to see", async () => {
    await changeHomeLayout(as("owner"), "distributor", { kind: "add", id: "ship" });
    expect((await getHomeLayout(as("owner", { stock: false }), "distributor")).widgets).not.toContain("ship");
    expect((await getHomeLayout(as("owner"), "distributor")).widgets).toContain("ship"); // back when stock is on again
    await changeHomeLayout(as("owner"), "distributor", { kind: "reset" });
    expect(WIDGETS.every((id) => typeof widgetAllowed(as("viewer"), id) === "boolean")).toBe(true);
  });
});

describe("home figures", () => {
  it("adds a confirmed order to the hero total and its category, and shows the change on the period before", async () => {
    const before = (await heroFigures(as("owner"), 7))!;
    const product = (await listProducts(as("owner"))).find((p) => p.category)!;
    const customer = (await listCustomers(as("owner")))[0]!;
    const make = async (amount: number, daysAgo: number) => {
      const quote = await createQuote(as("sales"), { customerId: customer.id, taxRatePercent: 8, lines: [{ productId: product.id, qty: 1, unitPrice: amount }] });
      await confirmOrder(as("sales"), quote.id);
      if (daysAgo) await owner.query("update sales_orders set confirmed_at = now() - make_interval(days => $2) where id = $1", [quote.id, daysAgo]);
    };
    await make(300, 0);
    await make(100, 9); // the week before
    const after = (await heroFigures(as("owner"), 7))!;
    expect(after.total - before.total).toBeCloseTo(300, 2);
    const share = after.categories.reduce((s, c) => s + c.share, 0);
    expect(share).toBeCloseTo(1, 5);
    expect(after.categories.length).toBeLessThanOrEqual(3);
    expect(after.categories.reduce((s, c) => s + c.amount, 0)).toBeCloseTo(after.total, 2);
    expect(after.change).not.toBeNull();
    expect(after.toCollect).not.toBeNull();
    const month = (await heroFigures(as("owner"), 30))!;
    expect(month.total).toBeGreaterThanOrEqual(after.total + 100);
    const span = (new Date(month.to).getTime() - new Date(month.from).getTime()) / 86_400_000;
    expect(span).toBe(29);
  });

  it("hides the hero and money owed from roles that may not see them", async () => {
    expect(await heroFigures(as("warehouse"), 7)).toBeNull();
    expect((await heroFigures(as("sales"), 7))!.toCollect).toBeNull();
    const h = await headline(as("warehouse"));
    expect(h.salesThisWeek).toBeNull();
    expect(h.unpaid).toBeNull();
    expect(h.readyToShip).not.toBeNull();
    expect(h.lowStock).not.toBeNull();
  });

  it("gives a business without stock quotes and open orders in place of shipping and low stock", async () => {
    const h = await headline(as("owner", { stock: false }));
    expect(h.readyToShip).toBeNull();
    expect(h.lowStock).toBeNull();
    expect(h.openOrders!.count).toBeGreaterThan(0);
    expect(h.openQuotes).not.toBeNull();
    const full = await headline(as("owner"));
    expect(full.salesThisWeek!.spark).toHaveLength(14);
    expect(full.salesThisWeek!.total).toBeCloseTo((await dailySales(as("owner"), 7))!.reduce((s, d) => s + d.total, 0), 2);
  });

  it("counts orders into the right weekday and hour", async () => {
    await owner.query("update sales_orders set created_at = (date_trunc('week', now() at time zone 'America/New_York') + interval '2 days 10 hours') at time zone 'America/New_York' where id = (select id from sales_orders order by created_at limit 1)");
    const map = (await orderHeatmap(as("owner")))!;
    expect(map.grid).toHaveLength(map.hours.length);
    expect(map.grid[map.hours.indexOf(10)]![2]).toBeGreaterThanOrEqual(1); // Wednesday, 10 am
    expect(map.busiest).toBe(Math.max(...map.grid.flat()));
  });

  it("charts 30 days by day, the quarter by day and the year by week, each adding up to its total", async () => {
    const product = (await listProducts(as("owner")))[0]!;
    const customer = (await listCustomers(as("owner")))[0]!;
    const quote = await createQuote(as("sales"), { customerId: customer.id, lines: [{ productId: product.id, qty: 1, unitPrice: 40 }] });
    await confirmOrder(as("sales"), quote.id);
    const cal = (await owner.query("select (now() at time zone 'America/New_York')::date as today, date_trunc('quarter', now() at time zone 'America/New_York')::date as q, date_trunc('year', now() at time zone 'America/New_York')::date as y, (now() at time zone 'America/New_York')::date - date_trunc('quarter', now() at time zone 'America/New_York')::date as qdays, (now() at time zone 'America/New_York')::date - date_trunc('year', now() at time zone 'America/New_York')::date as ydays")).rows[0];
    const iso = (d: Date) => d.toLocaleDateString("en-CA");
    const month = (await salesSeries(as("owner"), "30d"))!;
    expect([month.bucket, month.points.length, month.to]).toEqual(["day", 30, iso(cal.today)]);
    const quarter = (await salesSeries(as("owner"), "quarter"))!;
    expect([quarter.bucket, quarter.from, quarter.points.length]).toEqual(["day", iso(cal.q), cal.qdays + 1]);
    const year = (await salesSeries(as("owner"), "ytd"))!;
    expect([year.bucket, year.from, year.points[0]!.date]).toEqual(["week", iso(cal.y), iso(cal.y)]);
    expect(year.points.length).toBeLessThanOrEqual(Math.ceil((cal.ydays + 1) / 7) + 1);
    for (const s of [month, quarter, year]) expect(s.points.reduce((n, p) => n + p.total, 0)).toBeCloseTo(s.total, 2);
    expect(year.total).toBeGreaterThanOrEqual(quarter.total);
    expect(month.total).toBeCloseTo((await dailySales(as("owner"), 30))!.reduce((n, d) => n + d.total, 0), 2);
    // An order from last year is in none of them.
    const old = await createQuote(as("sales"), { customerId: customer.id, lines: [{ productId: product.id, qty: 1, unitPrice: 999 }] });
    await confirmOrder(as("sales"), old.id);
    await owner.query("update sales_orders set confirmed_at = $2::date - 5 where id = $1", [old.id, iso(cal.y)]);
    expect((await salesSeries(as("owner"), "ytd"))!.total).toBeCloseTo(year.total, 2);
    expect(await salesSeries(as("viewer", { stock: true }), "ytd")).not.toBeNull();
  });
});
