import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "../platform/context";
import { StateError, ValidationError } from "../platform/errors";
import { can, ForbiddenError } from "../platform/permissions";
import { requireDeals, seesCost, type DealPayment } from "./deals";

/**
 * Everything a dealer does around a sale: the title follow-up after delivery, the IRS cash report,
 * who sold the car and what they earn, what each car really cost, the paperwork and photos kept
 * with deals and cars, and the reports that come out of all of it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const cents = (n: number) => Math.round(n * 100) / 100;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const audit = (tx: { query: (q: string, v: unknown[]) => Promise<unknown> }, ctx: Ctx, action: string, type: string, id: string, after: unknown) =>
  tx.query("insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after) values ($1, 'user', $2, $3, $4, $5, $6)", [ctx.orgId, ctx.userId, action, type, id, JSON.stringify(after)]);

/* ------------------------------------------------------------------ Form 8300 */

/** The IRS reporting line: more than this in cash on one sale must be reported. */
export const CASH_REPORT_THRESHOLD = 10_000;

export type CashReport = {
  /** Cash and cash-like payments that count toward the $10,000. */
  counted: DealPayment[];
  total: number;
  /** Whether the deal has passed $10,000 in counted cash. */
  required: boolean;
  /** The day the counted cash passed $10,000, and the 15th day after it. */
  crossedOn: string | null;
  dueOn: string | null;
};

/**
 * What counts toward Form 8300 on a car sale: notes and coins, plus a cashier's check or money order
 * of $10,000 or less (a car is a "designated reporting transaction", so those count as cash).
 * Personal checks, bank transfers and cards never count. Payments on the same deal add together.
 */
export function cashReport(payments: DealPayment[]): CashReport {
  const counted = payments.filter((p) => p.method === "Cash" || ((p.method === "Cashier's check" || p.method === "Money order") && p.amount <= CASH_REPORT_THRESHOLD));
  let running = 0;
  let crossedOn: string | null = null;
  for (const p of [...counted].sort((a, b) => a.paidOn.localeCompare(b.paidOn))) {
    running = cents(running + p.amount);
    if (crossedOn === null && running > CASH_REPORT_THRESHOLD) crossedOn = p.paidOn;
  }
  return { counted, total: running, required: crossedOn !== null, crossedOn, dueOn: crossedOn && addDays(crossedOn, 15) };
}

/* ------------------------------------------------------------------ After the sale */

export type FollowUpInput = {
  tempTagNumber?: string;
  tempTagIssuedOn?: string;
  tempTagExpiresOn?: string;
  titleSentOn?: string;
  plateNumber?: string;
  titleDoneOn?: string;
  buyerOccupation?: string;
  form8300FiledOn?: string;
  salespersonId?: string;
  /** Only people who may see costs can set it; for everyone else it is left as it is. */
  commission?: number | null;
};

const shortText = (v: string | undefined, max: number, field: string) => {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t.length > max) throw new ValidationError(field, `Keep this under ${max} characters.`);
  return t || null;
};
const day = (v: string | undefined, field: string) => {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (!t) return null;
  if (!DATE.test(t)) throw new ValidationError(field, "Enter the date as YYYY-MM-DD.");
  return t;
};

/**
 * The paperwork trail after the deal is written: temp tag, title application, plate, the 8300 filing
 * date, and who sold it. Allowed on open and delivered deals; a temp tag runs 30 days unless told otherwise.
 */
export async function updateDealFollowUp(ctx: Ctx, id: string, input: FollowUpInput): Promise<void> {
  requireDeals(ctx, true);
  if (!UUID.test(id)) throw new StateError("Deal not found.");
  const tempTagIssuedOn = day(input.tempTagIssuedOn, "tempTagIssuedOn");
  let tempTagExpiresOn = day(input.tempTagExpiresOn, "tempTagExpiresOn");
  const tempTagNumber = shortText(input.tempTagNumber, 20, "tempTagNumber");
  if (tempTagNumber && tempTagIssuedOn && !tempTagExpiresOn) tempTagExpiresOn = addDays(tempTagIssuedOn, 30);
  const values: Record<string, unknown> = {
    temp_tag_number: tempTagNumber,
    temp_tag_issued_on: tempTagIssuedOn,
    temp_tag_expires_on: tempTagExpiresOn,
    title_sent_on: day(input.titleSentOn, "titleSentOn"),
    plate_number: shortText(input.plateNumber, 20, "plateNumber"),
    title_done_on: day(input.titleDoneOn, "titleDoneOn"),
    buyer_occupation: shortText(input.buyerOccupation, 80, "buyerOccupation"),
    form_8300_filed_on: day(input.form8300FiledOn, "form8300FiledOn"),
  };
  if (input.salespersonId !== undefined) {
    const sp = input.salespersonId.trim();
    if (sp && !UUID.test(sp)) throw new ValidationError("salespersonId", "Choose someone from the list.");
    values.salesperson_id = sp || null;
  }
  if (input.commission !== undefined && seesCost(ctx)) {
    if (input.commission !== null && (!Number.isFinite(input.commission) || input.commission < 0 || input.commission > 1e7)) throw new ValidationError("commission", "Enter a commission of zero or more.");
    values.commission = input.commission === null ? null : cents(input.commission);
  }
  const set = Object.entries(values).filter(([, v]) => v !== undefined);
  if (!set.length) return;
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const d = await tx.query<{ status: string }>("select status from deals where id = $1 for update", [id]);
    if (!d.rows[0]) throw new StateError("Deal not found.");
    if (d.rows[0].status === "cancelled") throw new StateError("This deal was cancelled.");
    if (values.salesperson_id) {
      const member = await tx.query("select 1 from memberships where user_id = $1 and status = 'active'", [values.salesperson_id]);
      if (member.rowCount === 0) throw new ValidationError("salespersonId", "Choose someone on your team.");
    }
    await tx.query(`update deals set updated_at = now(), ${set.map(([k], i) => `${k} = $${i + 2}`).join(", ")} where id = $1`, [id, ...set.map(([, v]) => v)]);
    await audit(tx, ctx, "deal.follow_up", "deal", id, Object.fromEntries(set));
  });
}

/* ------------------------------------------------------------------ Costs on a car */

export const COST_KINDS = ["recon", "parts", "labour", "detail", "transport", "auction_fee", "inspection", "other"] as const;
export type CostKind = (typeof COST_KINDS)[number];
export const COST_KIND_TEXT: Record<CostKind, string> = { recon: "Reconditioning", parts: "Parts", labour: "Labour", detail: "Detailing", transport: "Transport", auction_fee: "Auction fee", inspection: "Inspection", other: "Other" };
export type VehicleCost = { id: string; kind: CostKind; description: string | null; amount: number; spentOn: string; by: string | null };

function requireCosts(ctx: Ctx, write: boolean) {
  requireDeals(ctx, write);
  if (!seesCost(ctx)) throw new ForbiddenError("product.cost.view");
}

export async function listVehicleCosts(ctx: Ctx, vehicleId: string): Promise<VehicleCost[]> {
  requireCosts(ctx, false);
  if (!UUID.test(vehicleId)) return [];
  const r = await withTenant(ctx.pool, ctx.orgId, (tx) =>
    tx.query<VehicleCost>(
      `select c.id, c.kind, c.description, c.amount::float8 as amount, to_char(c.spent_on, 'YYYY-MM-DD') as "spentOn", u.name as by
         from vehicle_costs c left join users u on u.id = c.created_by where c.vehicle_id = $1 order by c.spent_on, c.created_at`,
      [vehicleId],
    ),
  );
  return r.rows;
}

export async function addVehicleCost(ctx: Ctx, vehicleId: string, input: { kind: string; description?: string; amount: number; spentOn: string }): Promise<string> {
  requireCosts(ctx, true);
  if (!UUID.test(vehicleId)) throw new StateError("Vehicle not found.");
  if (!(COST_KINDS as readonly string[]).includes(input.kind)) throw new ValidationError("kind", "Choose what the money was for.");
  if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > 1e7) throw new ValidationError("amount", "Enter an amount above zero.");
  if (!DATE.test(input.spentOn)) throw new ValidationError("spentOn", "Enter the date as YYYY-MM-DD.");
  const description = shortText(input.description, 200, "description") ?? null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const car = await tx.query("select 1 from vehicles where id = $1", [vehicleId]);
    if (car.rowCount === 0) throw new StateError("Vehicle not found.");
    const made = await tx.query<{ id: string }>(
      "insert into vehicle_costs (org_id, vehicle_id, kind, description, amount, spent_on, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [ctx.orgId, vehicleId, input.kind, description, cents(input.amount), input.spentOn, ctx.userId],
    );
    await audit(tx, ctx, "vehicle.cost_added", "vehicle", vehicleId, { kind: input.kind, amount: cents(input.amount) });
    return made.rows[0]!.id;
  });
}

export async function removeVehicleCost(ctx: Ctx, costId: string): Promise<void> {
  requireCosts(ctx, true);
  if (!UUID.test(costId)) throw new StateError("Cost not found.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const gone = await tx.query<{ vehicle_id: string; amount: number }>("delete from vehicle_costs where id = $1 returning vehicle_id, amount::float8 as amount", [costId]);
    if (!gone.rows[0]) throw new StateError("Cost not found.");
    await audit(tx, ctx, "vehicle.cost_removed", "vehicle", gone.rows[0].vehicle_id, { amount: gone.rows[0].amount });
  });
}

/* ------------------------------------------------------------------ Files and photos */

export const FILE_KINDS = ["signed_form", "licence", "title", "receipt", "photo", "other"] as const;
export type FileKind = (typeof FILE_KINDS)[number];
export const FILE_KIND_TEXT: Record<FileKind, string> = { signed_form: "Signed form", licence: "Buyer's licence", title: "Title", receipt: "Receipt", photo: "Photo", other: "Other" };
/** What can be kept. Images are shrunk in the browser first; a PDF is kept as it is. */
export const FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
/** Under the 4.5 MB a single upload can carry. */
export const MAX_FILE_BYTES = 4_400_000;
export type DealerFile = { id: string; kind: FileKind; name: string; contentType: string; sizeBytes: number; position: number; createdAt: Date; by: string | null };

export async function addDealerFile(ctx: Ctx, input: { dealId?: string; vehicleId?: string; kind: string; name: string; contentType: string; data: Uint8Array }): Promise<string> {
  requireDeals(ctx, true);
  const target = input.dealId ? { col: "deal_id", id: input.dealId, table: "deals" } : input.vehicleId ? { col: "vehicle_id", id: input.vehicleId, table: "vehicles" } : null;
  if (!target || !UUID.test(target.id)) throw new StateError("Choose a deal or a vehicle for the file.");
  const kind = target.col === "vehicle_id" ? "photo" : input.kind;
  if (!(FILE_KINDS as readonly string[]).includes(kind) || (target.col === "deal_id" && kind === "photo")) throw new ValidationError("kind", "Choose what the file is.");
  if (!(FILE_TYPES as readonly string[]).includes(input.contentType)) throw new ValidationError("file", "Upload a photo (JPEG, PNG or WebP) or a PDF.");
  if (kind === "photo" && input.contentType === "application/pdf") throw new ValidationError("file", "Car photos must be images.");
  if (input.data.byteLength === 0) throw new ValidationError("file", "That file is empty.");
  if (input.data.byteLength > MAX_FILE_BYTES) throw new ValidationError("file", "That file is over 4.4 MB. Scan at a lower resolution or split it into pages.");
  const name = input.name.trim().replace(/[\\/\r\n"]/g, "_").slice(0, 120) || "file";
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const owner = await tx.query(`select 1 from ${target.table} where id = $1`, [target.id]);
    if (owner.rowCount === 0) throw new StateError(target.col === "deal_id" ? "Deal not found." : "Vehicle not found.");
    const next = await tx.query<{ n: number }>(`select coalesce(max(position) + 1, 0)::int as n from dealer_files where ${target.col} = $1`, [target.id]);
    const made = await tx.query<{ id: string }>(
      `insert into dealer_files (org_id, ${target.col}, kind, name, content_type, size_bytes, data, position, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [ctx.orgId, target.id, kind, name, input.contentType, input.data.byteLength, Buffer.from(input.data), next.rows[0]!.n, ctx.userId],
    );
    await audit(tx, ctx, "file.added", target.col === "deal_id" ? "deal" : "vehicle", target.id, { kind, name, bytes: input.data.byteLength });
    return made.rows[0]!.id;
  });
}

export async function listDealerFiles(ctx: Ctx, owner: { dealId: string } | { vehicleId: string }): Promise<DealerFile[]> {
  requireDeals(ctx, false);
  const [col, id] = "dealId" in owner ? ["deal_id", owner.dealId] : ["vehicle_id", owner.vehicleId];
  if (!UUID.test(id)) return [];
  const r = await withTenant(ctx.pool, ctx.orgId, (tx) =>
    tx.query<DealerFile>(
      `select f.id, f.kind, f.name, f.content_type as "contentType", f.size_bytes as "sizeBytes", f.position, f.created_at as "createdAt", u.name as by
         from dealer_files f left join users u on u.id = f.created_by where f.${col} = $1 order by f.position, f.created_at`,
      [id],
    ),
  );
  return r.rows;
}

/** One file's contents, for someone signed in to the company that holds it. */
export async function getDealerFile(ctx: Ctx, fileId: string): Promise<{ name: string; contentType: string; data: Buffer; dealId: string | null; vehicleId: string | null } | null> {
  requireDeals(ctx, false);
  if (!UUID.test(fileId)) return null;
  const r = await withTenant(ctx.pool, ctx.orgId, (tx) =>
    tx.query<{ name: string; contentType: string; data: Buffer; dealId: string | null; vehicleId: string | null }>(
      `select name, content_type as "contentType", data, deal_id as "dealId", vehicle_id as "vehicleId" from dealer_files where id = $1`,
      [fileId],
    ),
  );
  return r.rows[0] ?? null;
}

export async function removeDealerFile(ctx: Ctx, fileId: string): Promise<{ dealId: string | null; vehicleId: string | null }> {
  requireDeals(ctx, true);
  if (!UUID.test(fileId)) throw new StateError("File not found.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const gone = await tx.query<{ deal_id: string | null; vehicle_id: string | null; name: string }>("delete from dealer_files where id = $1 returning deal_id, vehicle_id, name", [fileId]);
    const row = gone.rows[0];
    if (!row) throw new StateError("File not found.");
    await audit(tx, ctx, "file.removed", row.deal_id ? "deal" : "vehicle", (row.deal_id ?? row.vehicle_id)!, { name: row.name });
    return { dealId: row.deal_id, vehicleId: row.vehicle_id };
  });
}

/** Makes a photo the first one, the cover that listings show. */
export async function makeCoverPhoto(ctx: Ctx, fileId: string): Promise<string> {
  requireDeals(ctx, true);
  if (!UUID.test(fileId)) throw new StateError("Photo not found.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const f = await tx.query<{ vehicle_id: string | null }>("select vehicle_id from dealer_files where id = $1 and kind = 'photo'", [fileId]);
    const car = f.rows[0]?.vehicle_id;
    if (!car) throw new StateError("Photo not found.");
    await tx.query(
      `update dealer_files set position = s.n from (
         select id, (row_number() over (order by (id = $2) desc, position, created_at) - 1)::int as n from dealer_files where vehicle_id = $1
       ) s where dealer_files.id = s.id`,
      [car, fileId],
    );
    return car;
  });
}

/**
 * A car photo for anyone with its link, as listing sites need. Only photos of cars on the lot are
 * served; the id is random and unguessable. Uses a database function that returns that one row.
 */
export async function publicVehiclePhoto(pool: Ctx["pool"], fileId: string): Promise<{ contentType: string; data: Buffer } | null> {
  if (!UUID.test(fileId)) return null;
  const r = await pool.query<{ content_type: string; data: Buffer }>("select content_type, data from public_vehicle_photo($1)", [fileId]);
  const row = r.rows[0];
  return row ? { contentType: row.content_type, data: row.data } : null;
}

/* ------------------------------------------------------------------ Reports */

const range = (from: string, to: string) => {
  if (!DATE.test(from) || !DATE.test(to)) throw new ValidationError("from", "Enter the dates as YYYY-MM-DD.");
  return from <= to ? [from, to] : [to, from];
};

export type ProfitRow = {
  id: string; number: string; deliveredOn: string; buyerName: string; stockNumber: string; vehicleName: string;
  salePrice: number; dealerFee: number; carCost: number | null; costs: number; gross: number | null; commission: number; net: number | null; salespersonName: string | null;
};

/** Profit on each car delivered between two dates: price and fee, less the car and what was spent on it, less commission. */
export async function dealerProfit(ctx: Ctx, fromIso: string, toIso: string): Promise<{ rows: ProfitRow[]; totals: { deals: number; sales: number; gross: number; commission: number; net: number; unknownCost: number } }> {
  requireCosts(ctx, false);
  const [from, to] = range(fromIso, toIso);
  const r = await withTenant(ctx.pool, ctx.orgId, (tx) =>
    tx.query<Omit<ProfitRow, "gross" | "net">>(
      `select d.id, d.number, to_char(d.delivered_on, 'YYYY-MM-DD') as "deliveredOn", d.buyer_name as "buyerName", v.stock_number as "stockNumber",
              concat_ws(' ', v.year::text, v.make, v.model, v.trim) as "vehicleName", d.sale_price::float8 as "salePrice", d.dealer_fee::float8 as "dealerFee",
              v.acquisition_price::float8 as "carCost", coalesce((select sum(c.amount) from vehicle_costs c where c.vehicle_id = v.id), 0)::float8 as costs,
              coalesce(d.commission, 0)::float8 as commission, (select u.name from users u where u.id = d.salesperson_id) as "salespersonName"
         from deals d join vehicles v on v.org_id = d.org_id and v.id = d.vehicle_id
        where d.status = 'delivered' and d.delivered_on between $1 and $2
        order by d.delivered_on, d.number`,
      [from, to],
    ),
  );
  const rows: ProfitRow[] = r.rows.map((row) => {
    const gross = row.carCost === null ? null : cents(row.salePrice + row.dealerFee - row.carCost - row.costs);
    return { ...row, gross, net: gross === null ? null : cents(gross - row.commission) };
  });
  const known = rows.filter((x) => x.gross !== null);
  return {
    rows,
    totals: {
      deals: rows.length,
      sales: cents(rows.reduce((n, x) => n + x.salePrice, 0)),
      gross: cents(known.reduce((n, x) => n + x.gross!, 0)),
      commission: cents(rows.reduce((n, x) => n + x.commission, 0)),
      net: cents(known.reduce((n, x) => n + x.net!, 0)),
      unknownCost: rows.length - known.length,
    },
  };
}

export type TaxRow = { county: string; surtaxPct: number; deals: number; taxable: number; stateTax: number; surtaxBase: number; surtax: number };

/**
 * Florida sales tax and county surtax collected on cars delivered in one month, county by county,
 * for the monthly sales tax return. Figures are the ones kept on each deal when it was written.
 */
export async function salesTaxReport(ctx: Ctx, month: string): Promise<{ month: string; rows: TaxRow[]; totals: Omit<TaxRow, "county" | "surtaxPct"> }> {
  requireDeals(ctx, false);
  if (!can(ctx, "report.view")) throw new ForbiddenError("report.view");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ValidationError("month", "Choose a month.");
  const r = await withTenant(ctx.pool, ctx.orgId, (tx) =>
    tx.query<TaxRow>(
      `with d as (
         select coalesce(nullif(trim(buyer_county), ''), 'County not recorded') as county, surtax_pct, surtax_cap,
                greatest(sale_price + dealer_fee - trade_allowance, 0) as taxable, state_tax_pct
           from deals where status = 'delivered' and to_char(delivered_on, 'YYYY-MM') = $1)
       select county, surtax_pct::float8 as "surtaxPct", count(*)::int as deals, sum(taxable)::float8 as taxable,
              sum(round(taxable * state_tax_pct / 100, 2))::float8 as "stateTax",
              sum(least(taxable, surtax_cap))::float8 as "surtaxBase",
              sum(round(least(taxable, surtax_cap) * surtax_pct / 100, 2))::float8 as surtax
         from d group by county, surtax_pct order by county, surtax_pct`,
      [month],
    ),
  );
  const sum = (k: keyof Omit<TaxRow, "county" | "surtaxPct">) => cents(r.rows.reduce((n, x) => n + x[k], 0));
  return { month, rows: r.rows, totals: { deals: sum("deals"), taxable: sum("taxable"), stateTax: sum("stateTax"), surtaxBase: sum("surtaxBase"), surtax: sum("surtax") } };
}

export type CommissionRow = { salespersonId: string | null; name: string; deals: number; sales: number; commission: number };

/** Cars each person delivered between two dates, and their commission. Deals with no salesperson are grouped together. */
export async function commissionReport(ctx: Ctx, fromIso: string, toIso: string): Promise<CommissionRow[]> {
  requireCosts(ctx, false);
  const [from, to] = range(fromIso, toIso);
  const r = await withTenant(ctx.pool, ctx.orgId, (tx) =>
    tx.query<CommissionRow>(
      `select d.salesperson_id as "salespersonId", coalesce(u.name, 'No salesperson recorded') as name, count(*)::int as deals,
              sum(d.sale_price)::float8 as sales, coalesce(sum(d.commission), 0)::float8 as commission
         from deals d left join users u on u.id = d.salesperson_id
        where d.status = 'delivered' and d.delivered_on between $1 and $2
        group by d.salesperson_id, u.name order by (d.salesperson_id is null), sum(d.sale_price) desc`,
      [from, to],
    ),
  );
  return r.rows;
}

/* ------------------------------------------------------------------ Listing feed */

export type ListingRow = {
  id: string; stockNumber: string; vin: string | null; year: number | null; make: string | null; model: string | null; trim: string | null;
  bodyStyle: string | null; mileage: number | null; askingPrice: number; colour: string | null; condition: string | null; description: string | null;
  transmission: string | null; drivetrain: string | null; fuelType: string | null; photoIds: string[];
};

/** Cars on the lot with an asking price, as listing sites take them, photos in order. */
export async function listingRows(ctx: Ctx): Promise<ListingRow[]> {
  requireDeals(ctx, false);
  const r = await withTenant(ctx.pool, ctx.orgId, (tx) =>
    tx.query<ListingRow>(
      `select v.id, v.stock_number as "stockNumber", v.vin, v.year, v.make, v.model, v.trim, v.body_style as "bodyStyle", v.mileage,
              v.asking_price::float8 as "askingPrice", v.colour, v.condition, v.description, v.transmission, v.drivetrain, v.fuel_type as "fuelType",
              coalesce((select array_agg(f.id::text order by f.position, f.created_at) from dealer_files f where f.vehicle_id = v.id and f.kind = 'photo'), '{}') as "photoIds"
         from vehicles v where v.status = 'on_lot' and v.asking_price is not null order by v.created_at desc`,
    ),
  );
  return r.rows;
}

/** The first photo of each car, for lists and the window sticker. */
export async function coverPhotos(ctx: Ctx, vehicleIds: string[]): Promise<Record<string, string>> {
  requireDeals(ctx, false);
  const ids = vehicleIds.filter((id) => UUID.test(id));
  if (!ids.length) return {};
  const r = await withTenant(ctx.pool, ctx.orgId, (tx) =>
    tx.query<{ vehicle_id: string; id: string }>(
      "select distinct on (vehicle_id) vehicle_id, id from dealer_files where kind = 'photo' and vehicle_id = any($1::uuid[]) order by vehicle_id, position, created_at",
      [ids],
    ),
  );
  return Object.fromEntries(r.rows.map((x) => [x.vehicle_id, x.id]));
}

/** Writes rows as CSV, quoting every cell so commas and quotes in descriptions are safe. Cells starting with = + - @ are prefixed so spreadsheets do not run them. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const t = v === null || v === undefined ? "" : String(v);
    const safe = /^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t) ? `'${t}` : t;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

