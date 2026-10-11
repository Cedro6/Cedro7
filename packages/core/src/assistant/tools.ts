import { customerStatement, listInvoices } from "../billing/invoices";
import { listProducts } from "../catalog/products";
import { listCustomers } from "../crm/customers";
import { listReminders, listTeam } from "../crm/reminders";
import type { Ctx } from "../platform/context";
import { featureOn } from "../platform/features";
import { attention } from "../platform/home";
import { can } from "../platform/permissions";
import { isReportPeriod, report } from "../platform/reports";
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
    name: "sales_report",
    description: "Sales figures for the last 30, 90 or 365 days: revenue, orders, change on the period before, best-selling products, biggest customers, what customers owe by age.",
    input_schema: { type: "object", properties: { days: { type: "number", enum: [30, 90, 365] } } },
    allowed: (ctx) => featureOn(ctx.features, "reports") && can(ctx, "report.view"),
    run: async (ctx, input) => {
      const days = Number(input.days);
      return report(ctx, isReportPeriod(days) ? days : 30);
    },
  },
];

export const toolsFor = (ctx: Ctx): AssistantTool[] => ASSISTANT_TOOLS.filter((tool) => tool.allowed(ctx));
