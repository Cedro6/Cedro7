import { zoneOf } from "../platform/locale";
import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "../platform/context";
import { ValidationError } from "../platform/errors";
import { featureOn } from "../platform/features";
import { can, ForbiddenError } from "../platform/permissions";

export type Reminder = {
  id: string;
  title: string;
  /** YYYY-MM-DD */
  dueOn: string;
  /** HH:MM on a 24-hour clock, or null for any time that day. */
  dueTime: string | null;
  customerId: string | null;
  /** Null when there is no customer or the role may not see customers. */
  customerName: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  done: boolean;
  /** Due before today and not done. */
  overdue: boolean;
};

export type CalendarEntry = {
  date: string;
  kind: "reminder" | "delivery" | "invoice_due";
  title: string;
  href: string;
  done: boolean;
  reminderId?: string;
};

/** "14:30" as "2:30 pm". */
export function clock(time: string): string {
  const [h = 0, m = 0] = time.split(":").map(Number);
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TODAY = (ctx: Ctx) => `(now() at time zone '${zoneOf(ctx)}')::date`;

/** Reminders are part of the calendar feature and open to everyone in the company. */
function requireCalendar(ctx: Ctx) {
  if (!featureOn(ctx.features, "calendar")) throw new ForbiddenError("customer.read");
}

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const SELECT = (ctx: Ctx) => `
  select r.id, r.title, to_char(r.due_on, 'YYYY-MM-DD') as "dueOn", to_char(r.due_time, 'HH24:MI') as "dueTime", r.customer_id as "customerId",
         ${can(ctx, "customer.read") ? "c.name" : "null"} as "customerName",
         r.assigned_to as "assignedTo", u.name as "assignedName",
         (r.done_at is not null) as done, (r.done_at is null and r.due_on < ${TODAY(ctx)}) as overdue
    from reminders r
    left join customers c on c.id = r.customer_id
    left join users u on u.id = r.assigned_to`;

export async function listReminders(
  ctx: Ctx,
  options: { customerId?: string; from?: string; to?: string; openOnly?: boolean; mineOnly?: boolean } = {},
): Promise<Reminder[]> {
  requireCalendar(ctx);
  if (options.customerId && !UUID.test(options.customerId)) return [];
  const from = options.from && validDate(options.from) ? options.from : null;
  const to = options.to && validDate(options.to) ? options.to : null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<Reminder>(
      `${SELECT(ctx)}
        where ($1::uuid is null or r.customer_id = $1)
          and ($2::date is null or r.due_on >= $2) and ($3::date is null or r.due_on <= $3)
          and (not $4 or r.done_at is null) and (not $5 or r.assigned_to = $6)
        order by (r.done_at is not null), r.due_on, r.due_time nulls first, r.created_at
        limit 500`,
      [options.customerId ?? null, from, to, options.openOnly ?? false, options.mineOnly ?? false, ctx.userId],
    );
    return result.rows;
  });
}

export async function createReminder(
  ctx: Ctx,
  input: { title: string; dueOn: string; dueTime?: string; customerId?: string; assignedTo?: string },
): Promise<{ id: string }> {
  requireCalendar(ctx);
  const title = input.title.trim();
  if (!title) throw new ValidationError("title", "Say what the reminder is for.");
  if (title.length > 200) throw new ValidationError("title", "Keep the reminder under 200 characters.");
  if (!validDate(input.dueOn)) throw new ValidationError("dueOn", "Choose a date.");
  const dueTime = input.dueTime?.trim() || null;
  if (dueTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) throw new ValidationError("dueTime", "Enter the time as hours and minutes, such as 14:30.");
  const customerId = input.customerId || null;
  if (customerId && (!UUID.test(customerId) || !can(ctx, "customer.read"))) throw new ValidationError("customerId", "Customer not found.");
  const assignedTo = input.assignedTo || ctx.userId;
  if (!UUID.test(assignedTo)) throw new ValidationError("assignedTo", "Choose who it is for.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    if (customerId && (await tx.query("select 1 from customers where id = $1", [customerId])).rowCount === 0) {
      throw new ValidationError("customerId", "Customer not found.");
    }
    if ((await tx.query("select 1 from memberships where user_id = $1 and status = 'active'", [assignedTo])).rowCount === 0) {
      throw new ValidationError("assignedTo", "That person is not on the team.");
    }
    const made = await tx.query<{ id: string }>(
      "insert into reminders (org_id, title, due_on, due_time, customer_id, assigned_to, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [ctx.orgId, title, input.dueOn, dueTime, customerId, assignedTo, ctx.userId],
    );
    return { id: made.rows[0]!.id };
  });
}

export async function setReminderDone(ctx: Ctx, id: string, done: boolean): Promise<void> {
  requireCalendar(ctx);
  if (!UUID.test(id)) throw new ValidationError("id", "Reminder not found.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const changed = await tx.query("update reminders set done_at = case when $2 then coalesce(done_at, now()) end where id = $1", [id, done]);
    if (changed.rowCount === 0) throw new ValidationError("id", "Reminder not found.");
  });
}

/** Only the person who made it, the person it is for, or someone who manages settings may remove a reminder. */
export async function removeReminder(ctx: Ctx, id: string): Promise<void> {
  requireCalendar(ctx);
  if (!UUID.test(id)) throw new ValidationError("id", "Reminder not found.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const gone = await tx.query("delete from reminders where id = $1 and ($2 or created_by = $3 or assigned_to = $3)", [id, can(ctx, "settings.manage"), ctx.userId]);
    if (gone.rowCount === 0) throw new ValidationError("id", "Only the person who made a reminder, or the person it is for, can remove it.");
  });
}

export type TeamMember = { id: string; name: string };
export async function listTeam(ctx: Ctx): Promise<TeamMember[]> {
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<TeamMember>("select u.id, u.name from memberships m join users u on u.id = m.user_id where m.status = 'active' order by u.name");
    return result.rows;
  });
}

/** Everything with a date in the range: reminders, deliveries expected from suppliers, and invoices falling due. */
export async function calendarEntries(ctx: Ctx, from: string, to: string): Promise<CalendarEntry[]> {
  requireCalendar(ctx);
  if (!validDate(from) || !validDate(to)) return [];
  const entries: CalendarEntry[] = (await listReminders(ctx, { from, to })).map((r) => ({
    date: r.dueOn,
    kind: "reminder",
    title: `${r.dueTime ? `${clock(r.dueTime)} ` : ""}${r.customerName ? `${r.title} · ${r.customerName}` : r.title}`,
    href: r.customerId && can(ctx, "customer.read") ? `/customers/${r.customerId}` : `/calendar?day=${r.dueOn}`,
    done: r.done,
    reminderId: r.id,
  }));
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    if (featureOn(ctx.features, "purchasing") && can(ctx, "purchase_order.read")) {
      const pos = await tx.query<{ id: string; number: string; supplier: string; date: string; received: boolean }>(
        `select po.id, po.number, s.name as supplier, to_char(po.expected_on, 'YYYY-MM-DD') as date, (po.status = 'received') as received
           from purchase_orders po join suppliers s on s.id = po.supplier_id
          where po.expected_on between $1 and $2 and po.status in ('approved', 'sent', 'partially_received', 'received')`,
        [from, to],
      );
      for (const po of pos.rows) entries.push({ date: po.date, kind: "delivery", title: `${po.number} from ${po.supplier}`, href: `/purchasing/${po.id}`, done: po.received });
    }
    if (can(ctx, "sales_order.read")) {
      const due = await tx.query<{ id: string; number: string; customer: string; date: string; paid: boolean }>(
        `select i.id, i.number, c.name as customer, to_char((i.due_at at time zone $3)::date, 'YYYY-MM-DD') as date,
                (i.amount <= coalesce((select sum(p.amount) from payments p where p.invoice_id = i.id), 0)
                           + coalesce((select sum(a.amount) from credit_applications a where a.invoice_id = i.id), 0)) as paid
           from invoices i join customers c on c.id = i.customer_id
          where i.voided_at is null and (i.due_at at time zone $3)::date between $1 and $2`,
        [from, to, zoneOf(ctx)],
      );
      for (const i of due.rows) entries.push({ date: i.date, kind: "invoice_due", title: `${i.number} due · ${i.customer}`, href: `/invoices/${i.id}`, done: i.paid });
    }
  });
  return entries.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
}
