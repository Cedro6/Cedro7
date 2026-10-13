import { customerStatement, listInvoices } from "../billing/invoices";
import { listProducts } from "../catalog/products";
import { listCustomers } from "../crm/customers";
import { listReminders, listTeam } from "../crm/reminders";
import type { Ctx } from "../platform/context";
import { featureOn } from "../platform/features";
import { attention } from "../platform/home";
import { can } from "../platform/permissions";
import { analysis, ANALYSIS_PRESETS, COMPARE_MODES, isAnalysisPreset, isCompareMode, resolveRange } from "../platform/analysis";
import { todayIn, zoneOf } from "../platform/locale";
import { listPurchaseOrders, listSuppliers } from "../purchasing/orders";
import { listOrders } from "../sales/orders";
import { dealerAttention } from "../dealer/attention";
import { dealSalesSeries, getDeal, listDeals, type DealStatus } from "../dealer/deals";
import { getVehicle, listVehicles, lotSummary, isVehicleStatus } from "../dealer/vehicles";

/** Dealer Terminal companies get lookups about cars and deals instead of orders, invoices and stock. */
export const isDealer = (ctx: Ctx) => featureOn(ctx.features, "dealer");

/**
 * What the assistant may look up. Every tool here only reads (changes are prepared separately, in actions.ts), and each one goes through the same
 * functions the screens use, so the person's role and the company's feature switches apply
 * exactly as they do on screen. A tool the person could not use is not offered at all.
 */
export type AssistantTool = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  allowed: (ctx: Ctx) => boolean;
  run: (ctx: Ctx, input: Record<string, unknown>) => Promise<unknown>;
};

const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 100) : "");
const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);
const cap = <T>(rows: T[], n = 25) => ({ shown: Math.min(rows.length, n), total: rows.length, rows: rows.slice(0, n) });
const none = { type: "object" as const, properties: {} };

export const ASSISTANT_TOOLS: AssistantTool[] = [
  {
    name: "needs_attention",
    description: "What needs attention today: overdue invoices, low stock, orders ready to ship, late supplier orders, customers gone quiet.",
    input_schema: none,
    allowed: (ctx) => !isDealer(ctx),
    run: async (ctx) => (await attention(ctx)).map(({ title, detail, href }) => ({ title, detail, link: href })),
  },
  {
    name: "find_customers",
    description: "Search customers by name. Returns id, name, payment terms, main contact and a link.",
    input_schema: { type: "object", properties: { search: { type: "string", description: "Part of the name. Leave out to list all." } } },
    allowed: (ctx) => can(ctx, "customer.read"),
    run: async (ctx, input) =>
      cap((await listCustomers(ctx, { search: text(input.search) })).map((c) => ({ id: c.id, name: c.name, terms: c.paymentTerms, contact: c.primaryContact, link: `/customers/${c.id}` }))),
  },
  {
    name: "customer_account",
    description: "One customer's money position: what they owe, what is overdue, credit held, and their unpaid invoices. Needs the customer id from find_customers.",
    input_schema: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"] },
    allowed: (ctx) => !isDealer(ctx) && can(ctx, "customer.read") && can(ctx, "sales_order.read"),
    run: async (ctx, input) => {
      const id = text(input.customer_id);
      const statement = await customerStatement(ctx, id);
      if (!statement) return { error: "No customer with that id." };
      const unpaid = await listInvoices(ctx, { customerId: id, state: "open" });
      return {
        owed: statement.owed,
        overdue: statement.overdue,
        credit: statement.credit,
        unpaidInvoices: unpaid.map((i) => ({ number: i.number, balance: i.balance, due: day(i.dueAt), state: i.state, link: `/invoices/${i.id}` })),
        link: `/customers/${id}`,
      };
    },
  },
  {
    name: "find_products",
    description: "Search products by name or code, or list only those running low. Returns price, stock available, on order and reorder point.",
    input_schema: { type: "object", properties: { search: { type: "string" }, low_stock_only: { type: "boolean" } } },
    allowed: (ctx) => !isDealer(ctx) && can(ctx, "product.read"),
    run: async (ctx, input) => {
      const tracked = featureOn(ctx.features, "stock");
      const rows = await listProducts(ctx, { search: text(input.search), lowStockOnly: tracked && input.low_stock_only === true });
      return cap(
        rows.map((p) => ({
          id: p.id,
          sku: p.sku,
          name: p.name,
          price: p.price,
          ...(p.cost !== null ? { cost: p.cost } : {}),
          ...(tracked ? { available: p.available, onOrder: p.onOrder, reorderAt: p.reorderPoint, low: p.lowStock } : {}),
          link: `/products/${p.id}`,
        })),
      );
    },
  },
  {
    name: "list_orders",
    description: "Sales orders, newest first. Filter by status: open (confirmed, not fully shipped), quote, shipped or cancelled.",
    input_schema: { type: "object", properties: { status: { type: "string", enum: ["open", "quote", "shipped", "cancelled"] }, customer_id: { type: "string" } } },
    allowed: (ctx) => !isDealer(ctx) && can(ctx, "sales_order.read"),
    run: async (ctx, input) => {
      const status = ["open", "quote", "shipped", "cancelled"].includes(String(input.status)) ? (input.status as "open" | "quote" | "shipped" | "cancelled") : undefined;
      const rows = await listOrders(ctx, { status, customerId: text(input.customer_id) || undefined });
      return cap(rows.map((o) => ({ id: o.id, number: o.number, customer: o.customerName, status: o.status, total: o.total, created: day(o.createdAt), link: `/sales/${o.id}` })));
    },
  },
  {
    name: "list_invoices",
    description: "Invoices. Filter by state: open (anything unpaid), overdue or paid. Returns balance and due date.",
    input_schema: { type: "object", properties: { state: { type: "string", enum: ["open", "overdue", "paid"] } } },
    allowed: (ctx) => !isDealer(ctx) && can(ctx, "sales_order.read"),
    run: async (ctx, input) => {
      const state = ["open", "overdue", "paid"].includes(String(input.state)) ? (input.state as "open" | "overdue" | "paid") : undefined;
      const rows = await listInvoices(ctx, { state });
      return cap(rows.map((i) => ({ id: i.id, number: i.number, customer: i.customerName, amount: i.amount, balance: i.balance, due: day(i.dueAt), state: i.state, link: `/invoices/${i.id}` })));
    },
  },
  {
    name: "list_purchase_orders",
    description: "Purchase orders placed with suppliers, with status, expected date and total.",
    input_schema: none,
    allowed: (ctx) => !isDealer(ctx) && featureOn(ctx.features, "purchasing") && can(ctx, "purchase_order.read"),
    run: async (ctx) =>
      cap((await listPurchaseOrders(ctx)).map((po) => ({ number: po.number, supplier: po.supplierName, status: po.status, total: po.total, expected: po.expectedOn ?? null, link: `/purchasing/${po.id}` }))),
  },
  {
    name: "list_reminders",
    description: "Reminders on the calendar that are not done yet, with due date, customer and who each is for. Also returns the team, with ids, for assigning a reminder to someone.",
    input_schema: { type: "object", properties: { customer_id: { type: "string" } } },
    allowed: (ctx) => featureOn(ctx.features, "calendar"),
    run: async (ctx, input) => ({
      reminders: cap((await listReminders(ctx, { openOnly: true, customerId: text(input.customer_id) || undefined })).map((r) => ({ title: r.title, due: r.dueOn, customer: r.customerName, for: r.assignedName, overdue: r.overdue }))),
      team: await listTeam(ctx),
      link: "/calendar",
    }),
  },
  {
    name: "find_suppliers",
    description: "The company's suppliers, with id, payment terms and lead time in days.",
    input_schema: none,
    allowed: (ctx) => !isDealer(ctx) && featureOn(ctx.features, "purchasing") && can(ctx, "purchase_order.read"),
    run: async (ctx) => cap((await listSuppliers(ctx)).map((s) => ({ id: s.id, name: s.name, terms: s.paymentTerms, leadTimeDays: s.leadTimeDays }))),
  },
  {
    name: "business_report",
    description:
      "The full report for a period, each figure beside the same figure for a comparison period: sales, orders, average order, units, margin, customers buying and new customers; best-selling products and biggest customers with their change; sales by category and by person; invoiced, payments received, days to get paid, what customers owe by age and who owes most; running costs, profit and unpaid bills; stock value and stock that did not sell; purchasing by supplier. Use this for any question about how the business is doing, growth, comparisons, profit or costs.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", enum: ANALYSIS_PRESETS.filter((p) => p !== "custom"), description: "Defaults to 30d (the last 30 days). ytd is the year to date, 12m the last 12 months." },
        compare: { type: "string", enum: [...COMPARE_MODES], description: "previous (the same length just before, the default), year (the same dates a year earlier) or none." },
      },
    },
    allowed: (ctx) => !isDealer(ctx) && featureOn(ctx.features, "reports") && can(ctx, "report.view"),
    run: async (ctx, input) => {
      const period = isAnalysisPreset(input.period) && input.period !== "custom" ? input.period : "30d";
      const mode = isCompareMode(input.compare) ? input.compare : "previous";
      const data = await analysis(ctx, { range: resolveRange(period, todayIn(zoneOf(ctx))), mode });
      const top = <T>(rows: T[], n = 10) => ({ total: rows.length, rows: rows.slice(0, n) });
      return {
        dates: data.range,
        comparedWith: data.compare,
        note: "Each figure is { now, was }: now is the chosen dates, was is the comparison dates (null when nothing is compared). Sales are orders confirmed, before tax.",
        sales: data.sales,
        products: top(data.products.map((p) => ({ name: p.name, sku: p.sku, link: `/products/${p.id}`, units: p.units, sales: p.revenue, margin: p.margin }))),
        customers: top(data.customers.map((c) => ({ name: c.name, link: `/customers/${c.id}`, new: c.isNew, orders: c.orders, sales: c.revenue }))),
        categories: data.categories,
        people: data.people.map((p) => ({ name: p.name, orders: p.orders, sales: p.revenue })),
        money: { ...data.money, debtors: top(data.money.debtors.map((d) => ({ name: d.name, link: `/customers/${d.id}`, owed: d.owed, overdue: d.overdue, oldestDaysLate: d.oldest }))) },
        costsAndProfit: data.costs,
        stock: data.stock && { value: data.stock.value, units: data.stock.units, lowStock: data.stock.lowStock, valueNotSelling: data.stock.idleValue, notSelling: top(data.stock.idle.map((p) => ({ name: p.name, sku: p.sku, onHand: p.onHand, value: p.value })), 8) },
        purchasing: data.purchasing && { ...data.purchasing, suppliers: top(data.purchasing.suppliers.map((s) => ({ name: s.name, orders: s.orders, ordered: s.ordered })), 8) },
        link: `/reports${period === "30d" && mode === "previous" ? "" : `?${new URLSearchParams({ ...(period !== "30d" ? { period } : {}), ...(mode !== "previous" ? { compare: mode } : {}) })}`}`,
      };
    },
  },
  {
    name: "lot_attention",
    description: "What needs the dealer today: money still owed on open deals, deals paid but not delivered, title paperwork that is incomplete, cars on the lot 60+ days or with no asking price or title number, drafts left unfinished, cars stuck in reconditioning. Each item has a link to the one record.",
    input_schema: none,
    allowed: (ctx) => isDealer(ctx) && can(ctx, "vehicle.read"),
    run: async (ctx) => {
      const items = await dealerAttention(ctx);
      const due = featureOn(ctx.features, "calendar") ? (await listReminders(ctx, { to: todayIn(zoneOf(ctx)), openOnly: true })).map((r) => ({ title: `Reminder: ${r.title}`, detail: `${r.overdue ? "Overdue" : "Due today"}${r.customerName ? `, ${r.customerName}` : ""}${r.assignedName ? `, for ${r.assignedName}` : ""}`, link: "/calendar" })) : [];
      return { items: items.map(({ title, detail, link }) => ({ title, detail, link })), reminders: due };
    },
  },
  {
    name: "lot_overview",
    description: "The lot at a glance: how many cars are on the lot, in reconditioning and in draft, how many have been on hand 60+ days, and what was paid for the cars on hand (when the person may see cost).",
    input_schema: none,
    allowed: (ctx) => isDealer(ctx) && can(ctx, "vehicle.read"),
    run: async (ctx) => ({ ...(await lotSummary(ctx)), link: "/vehicles" }),
  },
  {
    name: "find_vehicles",
    description: "Search the dealer's vehicles by stock number, VIN, year, make, model, trim or colour, optionally by status (live = everything not sold or removed). Returns id, stock number, the car, VIN, mileage, asking price, days on hand, status and a link. Use the id for vehicle_detail or the propose_ tools.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Words to match, such as 'silver camry' or 'STK-000012'. Leave out to list." },
        status: { type: "string", enum: ["live", "draft", "recon", "on_lot", "sold", "removed"], description: "Defaults to live." },
      },
    },
    allowed: (ctx) => isDealer(ctx) && can(ctx, "vehicle.read"),
    run: async (ctx, input) => {
      const words = text(input.search).toLowerCase().split(/\s+/).filter(Boolean);
      const status = input.status === "live" || isVehicleStatus(input.status) ? (input.status as "live") : "live";
      const all = await listVehicles(ctx, { status });
      const hay = (v: (typeof all)[number]) => `${v.stockNumber} ${v.vin ?? ""} ${v.year ?? ""} ${v.make ?? ""} ${v.model ?? ""} ${v.trim ?? ""} ${v.colour ?? ""}`.toLowerCase();
      const rows = words.length ? all.filter((v) => words.every((w) => hay(v).includes(w))) : all;
      return cap(rows.map((v) => ({ id: v.id, stock: v.stockNumber, car: [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ") || null, colour: v.colour ?? null, vin: v.vin, mileage: v.mileage ?? null, asking: v.askingPrice ?? null, daysOnHand: v.daysHeld, status: v.status, link: `/vehicles/${v.id}` })), 30);
    },
  },
  {
    name: "vehicle_detail",
    description: "Everything on one vehicle: specifications, mileage, condition, title number, asking price, what was paid (when the person may see cost), status, days on hand, notes, and its open deal if any. Needs the vehicle id from find_vehicles.",
    input_schema: { type: "object", properties: { vehicle_id: { type: "string" } }, required: ["vehicle_id"] },
    allowed: (ctx) => isDealer(ctx) && can(ctx, "vehicle.read"),
    run: async (ctx, input) => {
      const v = await getVehicle(ctx, text(input.vehicle_id));
      if (!v) return { error: "No vehicle with that id." };
      const seeCost = can(ctx, "product.cost.view");
      const open = (await listDeals(ctx, { status: "open", search: v.stockNumber })).find((d) => d.stockNumber === v.stockNumber);
      return {
        stock: v.stockNumber, vin: v.vin, year: v.year, make: v.make, model: v.model, trim: v.trim, body: v.bodyStyle, engine: v.engine, drivetrain: v.drivetrain, fuel: v.fuelType,
        colour: v.colour, mileage: v.mileage, condition: v.condition, titleNumber: v.titleNumber ?? null, asking: v.askingPrice ?? null,
        ...(seeCost ? { paid: v.acquisitionPrice ?? null, boughtFrom: v.acquisitionSource ?? null } : {}),
        status: v.status, daysOnHand: v.daysHeld, location: v.locationName, notes: v.notes ?? null,
        openDeal: open ? { number: open.number, buyer: open.buyerName, owed: open.balance, link: `/deals/${open.id}` } : null,
        link: `/vehicles/${v.id}`,
      };
    },
  },
  {
    name: "find_deals",
    description: "Deals by status (open, delivered, cancelled) or search by deal number, buyer, stock number or VIN. Returns number, buyer, car, total, balance still owed, delivered date and a link.",
    input_schema: { type: "object", properties: { status: { type: "string", enum: ["open", "delivered", "cancelled"] }, search: { type: "string" } } },
    allowed: (ctx) => isDealer(ctx) && can(ctx, "vehicle.read"),
    run: async (ctx, input) => {
      const status = ["open", "delivered", "cancelled"].includes(String(input.status)) ? (input.status as DealStatus) : undefined;
      return cap((await listDeals(ctx, { status, search: text(input.search) })).map((d) => ({ id: d.id, number: d.number, buyer: d.buyerName, car: d.vehicleName || d.stockNumber, stock: d.stockNumber, status: d.status, total: d.total, owed: d.balance, delivered: d.deliveredOn, link: `/deals/${d.id}` })));
    },
  },
  {
    name: "deal_detail",
    description: "One deal in full: buyer, car, price, dealer fee, trade-in, tax, fees, total, payments recorded and what is still owed, odometer, and what the title paperwork still needs. Needs the deal id from find_deals.",
    input_schema: { type: "object", properties: { deal_id: { type: "string" } }, required: ["deal_id"] },
    allowed: (ctx) => isDealer(ctx) && can(ctx, "vehicle.read"),
    run: async (ctx, input) => {
      const d = await getDeal(ctx, text(input.deal_id));
      if (!d) return { error: "No deal with that id." };
      const missing = [!d.buyerAddress && "buyer's address", !d.buyerDl && "licence number", !d.buyerDob && "date of birth", !d.buyerSex && "sex", !d.buyerCounty && "county", d.odometer === null && "odometer reading", !d.titleNumber && "the car's title number"].filter(Boolean);
      return {
        number: d.number, status: d.status, buyer: d.buyerName, coBuyer: d.coBuyerName, car: d.vehicleName, stock: d.stockNumber, vin: d.vin,
        salePrice: d.salePrice, dealerFee: d.dealerFee, tradeIn: d.tradeVin ? { vin: d.tradeVin, description: d.tradeDescription, allowance: d.tradeAllowance } : null,
        taxable: d.taxable, salesTax: d.stateTax, surtax: d.surtax, tagAndTitle: d.tagTitleFees, otherFees: d.otherFees, total: d.total,
        payments: d.payments.map((p) => ({ amount: p.amount, method: p.method, on: p.paidOn })), owed: d.balance,
        odometer: d.odometer, soldAsIs: d.soldAsIs, delivered: d.deliveredOn, paperworkMissing: missing, gross: d.gross,
        link: `/deals/${d.id}`,
      };
    },
  },
  {
    name: "dealer_sales",
    description: "Cars sold and sales totals (sale price, before tax and fees) for the last 30 days, this quarter or the year so far, counted by the day each deal was delivered.",
    input_schema: { type: "object", properties: { period: { type: "string", enum: ["30d", "quarter", "ytd"], description: "Defaults to 30d." } } },
    allowed: (ctx) => isDealer(ctx) && can(ctx, "vehicle.read"),
    run: async (ctx, input) => {
      const period = input.period === "quarter" || input.period === "ytd" ? input.period : "30d";
      const s = await dealSalesSeries(ctx, period);
      return s && { period, from: s.from, to: s.to, carsSold: s.cars, sales: s.total, link: "/deals?show=delivered" };
    },
  },
];

export const toolsFor = (ctx: Ctx): AssistantTool[] => ASSISTANT_TOOLS.filter((tool) => tool.allowed(ctx));
