import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import { calendarEntries, createReminder, ForbiddenError, listCustomers, listReminders, removeReminder, setReminderDone, ValidationError, type Ctx, type Role } from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
let otherUser: string;
const as = (role: Role, features?: Ctx["features"], user = userId): Ctx => ({ pool: app, orgId, userId: user, role, features });
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

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

describe("reminders", () => {
  it("creates a reminder for a customer, shows it overdue once the day passes, and ticks it off", async () => {
    const customer = (await listCustomers(as("owner")))[0]!;
    const { id } = await createReminder(as("sales"), { title: "Call about the spring order", dueOn: day(-2), customerId: customer.id });
    await createReminder(as("sales"), { title: "Send catalogue", dueOn: day(3) });
    const forCustomer = await listReminders(as("sales"), { customerId: customer.id });
    expect(forCustomer).toHaveLength(1);
    expect(forCustomer[0]).toMatchObject({ title: "Call about the spring order", customerName: customer.name, overdue: true, done: false, assignedTo: userId });
    await setReminderDone(as("sales"), id, true);
    expect((await listReminders(as("sales"), { customerId: customer.id }))[0]).toMatchObject({ done: true, overdue: false });
    expect((await listReminders(as("sales"), { openOnly: true })).map((r) => r.title)).toEqual(["Send catalogue"]);
    await setReminderDone(as("sales"), id, false);
    expect((await listReminders(as("sales"), { openOnly: true }))).toHaveLength(2);
  });

  it("rejects a blank title, a bad date, an unknown customer and someone outside the team", async () => {
    await expect(createReminder(as("owner"), { title: " ", dueOn: day(1) })).rejects.toBeInstanceOf(ValidationError);
    await expect(createReminder(as("owner"), { title: "x", dueOn: "2026-02-31" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createReminder(as("owner"), { title: "x", dueOn: day(1), customerId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/Customer not found/);
    await expect(createReminder(as("owner"), { title: "x", dueOn: day(1), assignedTo: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/not on the team/);
  });

  it("hides the customer's name from a role without customer access and is off when the calendar is off", async () => {
    const seen = await listReminders(as("warehouse"));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.customerName === null)).toBe(true);
    await expect(listReminders(as("owner", { calendar: false }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createReminder(as("owner", { calendar: false }), { title: "x", dueOn: day(1) })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets only its maker, its assignee or a manager remove a reminder", async () => {
    const { id } = await createReminder(as("sales"), { title: "Mine", dueOn: day(1) });
    await expect(removeReminder(as("warehouse", undefined, otherUser), id)).rejects.toThrow(/Only the person/);
    await removeReminder(as("owner", undefined, otherUser), id); // a manager may
    expect((await listReminders(as("owner"))).some((r) => r.id === id)).toBe(false);
  });

  it("puts reminders, expected deliveries and invoices falling due on the calendar by day", async () => {
    await createReminder(as("owner"), { title: "Quarterly review", dueOn: day(5) });
    const supplier = (await owner.query<{ id: string }>("select id from suppliers where org_id = $1 limit 1", [orgId])).rows[0]!.id;
    await owner.query("insert into purchase_orders (org_id, number, supplier_id, status, expected_on) values ($1, 'PO-CAL-1', $2, 'sent', $3)", [orgId, supplier, day(6)]);
    const entries = await calendarEntries(as("owner"), day(0), day(10));
    expect(entries.find((e) => e.title === "Quarterly review")).toMatchObject({ date: day(5), kind: "reminder", done: false });
    expect(entries.find((e) => e.kind === "delivery")).toMatchObject({ date: day(6), title: expect.stringContaining("PO-CAL-1") });
    expect(entries.map((e) => e.date)).toEqual([...entries.map((e) => e.date)].sort());
    expect((await calendarEntries(as("sales"), day(0), day(10))).some((e) => e.kind === "delivery")).toBe(false);
    expect((await calendarEntries(as("owner", { purchasing: false }), day(0), day(10))).some((e) => e.kind === "delivery")).toBe(false);
  });
});
