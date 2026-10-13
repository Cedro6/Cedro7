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
    allowed: () => true,
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
    allowed: (ctx) => can(ctx, "customer.read") && can(ctx, "sales_order.read"),
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
    allowed: (ctx) => can(ctx, "product.read"),
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
    allowed: (ctx) => can(ctx, "sales_order.read"),
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
    allowed: (ctx) => can(ctx, "sales_order.read"),
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
    allowed: (ctx) => featureOn(ctx.features, "purchasing") && can(ctx, "purchase_order.read"),
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
    allowed: (ctx) => featureOn(ctx.features, "purchasing") && can(ctx, "purchase_order.read"),
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
    allowed: (ctx) => featureOn(ctx.features, "reports") && can(ctx, "report.view"),
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
];

export const toolsFor = (ctx: Ctx): AssistantTool[] => ASSISTANT_TOOLS.filter((tool) => tool.allowed(ctx));
