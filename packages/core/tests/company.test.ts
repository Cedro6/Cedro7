import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import { ForbiddenError, getCompanyProfile, getCustomer, listCustomers, setCompanyLogo, updateCompanyProfile, updateCustomer, ValidationError, type Ctx, type Role } from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
const as = (role: Role): Ctx => ({ pool: app, orgId, userId, role });
const png = `data:image/png;base64,${"A".repeat(400)}`;

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

describe("company details", () => {
  it("saves what goes on invoices and lets everyone in the company read it", async () => {
    await updateCompanyProfile(as("owner"), { name: "Harbor Supply Co.", address: "12 Dock Rd\nPortland, ME 04101", phone: "207-555-0100", email: "billing@harbor.test", taxNumber: "EIN 12-3456789", invoiceFooter: "Thank you." });
    expect(await getCompanyProfile(as("warehouse"))).toMatchObject({ address: "12 Dock Rd\nPortland, ME 04101", email: "billing@harbor.test", taxNumber: "EIN 12-3456789", invoiceFooter: "Thank you.", logo: null });
    await updateCompanyProfile(as("owner"), { name: "Harbor Supply Co.", phone: "" });
    expect(await getCompanyProfile(as("owner"))).toMatchObject({ address: null, phone: null });
  });

  it("is only changed by someone who manages settings, and checks the email", async () => {
    await expect(updateCompanyProfile(as("sales"), { name: "Hack" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setCompanyLogo(as("sales"), png)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateCompanyProfile(as("owner"), { name: "X", email: "nope" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateCompanyProfile(as("owner"), { name: " " })).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts a small PNG logo and refuses SVG, other data and oversized images", async () => {
    await setCompanyLogo(as("owner"), png);
    expect((await getCompanyProfile(as("owner"))).logo).toBe(png);
    await expect(setCompanyLogo(as("owner"), "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==")).rejects.toThrow(/PNG, JPEG or WebP/);
    await expect(setCompanyLogo(as("owner"), "https://example.com/logo.png")).rejects.toThrow(/PNG, JPEG or WebP/);
    await expect(setCompanyLogo(as("owner"), `data:image/png;base64,${"A".repeat(300_000)}`)).rejects.toThrow(/too large/);
    expect((await getCompanyProfile(as("owner"))).logo).toBe(png); // a refused upload leaves the old one
    await setCompanyLogo(as("owner"), null);
    expect((await getCompanyProfile(as("owner"))).logo).toBeNull();
  });

  it("keeps a customer's addresses unless they are sent", async () => {
    const c = (await listCustomers(as("owner")))[0]!;
    await updateCustomer(as("sales"), c.id, { name: c.name, billingAddress: "1 Main St\nBoston, MA", shippingAddress: "Dock 4, 9 Pier Ave" });
    await updateCustomer(as("sales"), c.id, { name: c.name, paymentTerms: "Net 30" }); // addresses not sent
    expect(await getCustomer(as("owner"), c.id)).toMatchObject({ billingAddress: "1 Main St\nBoston, MA", shippingAddress: "Dock 4, 9 Pier Ave", paymentTerms: "Net 30" });
    await updateCustomer(as("sales"), c.id, { name: c.name, shippingAddress: " " });
    expect(await getCustomer(as("owner"), c.id)).toMatchObject({ billingAddress: "1 Main St\nBoston, MA", shippingAddress: null });
  });
});
