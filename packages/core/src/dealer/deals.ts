import { withTenant, type PoolClient } from "@bos/db/runtime";
import { PAYMENT_METHODS } from "../billing/invoices";
import type { Ctx } from "../platform/context";
import { StateError, ValidationError } from "../platform/errors";
import { featureOn } from "../platform/features";
import { ForbiddenError, requirePermission } from "../platform/permissions";
import { nextNumber } from "../sales/orders";
import { cleanVin, vinProblem } from "./vin";

/**
 * Deals: one vehicle sold to one buyer. Florida cash sales for now: the dealer holds the title,
 * the buyer pays in full, the deal is delivered and the car is marked sold. The money arithmetic
 * is kept with the deal so the paperwork never changes under a signed copy.
 */

export const DEAL_STATUSES = ["open", "delivered", "cancelled"] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];
export const ODOMETER_BRANDS = ["actual", "not_actual", "exceeds"] as const;
export type OdometerBrand = (typeof ODOMETER_BRANDS)[number];
export const ODOMETER_TEXT: Record<OdometerBrand, string> = { actual: "Actual mileage", not_actual: "Not the actual mileage (warning: odometer discrepancy)", exceeds: "Exceeds its mechanical limits" };

export type DealInput = {
  vehicleId: string;
  customerId?: string | null;
  buyerName: string;
  buyerAddress?: string;
  buyerCity?: string;
  buyerState?: string;
  buyerZip?: string;
  buyerPhone?: string;
  buyerEmail?: string;
  buyerDl?: string;
  buyerDob?: string;
  buyerSex?: string;
  buyerCounty?: string;
  coBuyerName?: string;
  salePrice: number;
  dealerFee?: number;
  tradeAllowance?: number;
  tradeVin?: string;
  tradeDescription?: string;
  tradeMileage?: number;
  stateTaxPct?: number;
  surtaxPct?: number;
  surtaxCap?: number;
  tagTitleFees?: number;
  otherFees?: number;
  otherFeesNote?: string;
  odometer?: number;
  odometerBrand?: OdometerBrand;
  soldAsIs?: boolean;
  warrantyNote?: string;
  notes?: string;
};

/** The deal's arithmetic, in the order it appears on a Florida buyer's order. */
export type DealMoney = {
  salePrice: number;
  dealerFee: number;
  tradeAllowance: number;
  /** Price plus dealer fee less trade-in: what Florida taxes. */
  taxable: number;
  stateTax: number;
  /** County surtax applies to the first $5,000 (the cap) of the taxable amount. */
  surtax: number;
  tagTitleFees: number;
  otherFees: number;
  total: number;
  paid: number;
  balance: number;
};

export type Deal = DealMoney & {
  id: string;
  number: string;
  status: DealStatus;
  vehicleId: string;
  stockNumber: string;
  vin: string | null;
  vehicleName: string;
  vehicleCost: number | null;
  customerId: string | null;
  buyerName: string;
  buyerAddress: string | null;
  buyerCity: string | null;
  buyerState: string | null;
  buyerZip: string | null;
  buyerPhone: string | null;
  buyerEmail: string | null;
  buyerDl: string | null;
  buyerDob: string | null;
  buyerSex: string | null;
  buyerCounty: string | null;
  coBuyerName: string | null;
  /** The dealer's title for the car, needed on the forms. */
  titleNumber: string | null;
  titleState: string | null;
  vehicleColour: string | null;
  vehicleBody: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleYear: number | null;
  tradeVin: string | null;
  tradeDescription: string | null;
  tradeMileage: number | null;
  stateTaxPct: number;
  surtaxPct: number;
  surtaxCap: number;
  otherFeesNote: string | null;
  odometer: number | null;
  odometerBrand: OdometerBrand;
  soldAsIs: boolean;
  warrantyNote: string | null;
  notes: string | null;
  deliveredOn: string | null;
  cancelledReason: string | null;
  createdAt: Date;
  payments: DealPayment[];
  /** Sale price plus dealer fee less what the vehicle cost. Null when the role may not see cost. */
  gross: number | null;
};
export type DealPayment = { id: string; amount: number; method: string; reference: string | null; paidOn: string; recordedBy: string | null };
export type DealSummary = Pick<Deal, "id" | "number" | "status" | "stockNumber" | "vehicleName" | "buyerName" | "total" | "balance" | "deliveredOn" | "createdAt">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const cents = (n: number) => Math.round(n * 100) / 100;

function requireDeals(ctx: Ctx, write: boolean): void {
  requirePermission(ctx, write ? "vehicle.write" : "vehicle.read");
  if (!featureOn(ctx.features, "dealer")) throw new ForbiddenError(write ? "vehicle.write" : "vehicle.read");
}

/** Florida: 6% state tax on the price after trade-in, plus the county's surtax on the first $5,000 of it. */
export function dealMoney(d: { salePrice: number; dealerFee: number; tradeAllowance: number; stateTaxPct: number; surtaxPct: number; surtaxCap: number; tagTitleFees: number; otherFees: number }, paid = 0): DealMoney {
  const taxable = Math.max(cents(d.salePrice + d.dealerFee - d.tradeAllowance), 0);
  const stateTax = cents((taxable * d.stateTaxPct) / 100);
  const surtax = cents((Math.min(taxable, d.surtaxCap) * d.surtaxPct) / 100);
  const total = cents(taxable + stateTax + surtax + d.tagTitleFees + d.otherFees);
  return { salePrice: d.salePrice, dealerFee: d.dealerFee, tradeAllowance: d.tradeAllowance, taxable, stateTax, surtax, tagTitleFees: d.tagTitleFees, otherFees: d.otherFees, total, paid: cents(paid), balance: cents(total - paid) };
}

const text = (v: string | undefined, max: number, field: string) => {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t.length > max) throw new ValidationError(field, `Keep this under ${max} characters.`);
  return t || null;
};
const money = (v: number | undefined, field: string, fallback = 0) => {
  if (v === undefined) return fallback;
  if (!Number.isFinite(v) || v < 0 || v > 1e9) throw new ValidationError(field, "Enter an amount of zero or more.");
  return cents(v);
};
const pct = (v: number | undefined, field: string, fallback: number) => {
  if (v === undefined) return fallback;
  if (!Number.isFinite(v) || v < 0 || v >= 25) throw new ValidationError(field, "Enter a percentage from 0 to 25.");
  return Math.round(v * 1000) / 1000;
};

type Defaults = { stateTaxPct: number; surtaxPct: number; dealerFee: number; tagTitleFees: number };
async function defaults(tx: PoolClient, orgId: string): Promise<Defaults> {
  const r = await tx.query<{ surtax: number; fee: number; tag: number }>("select county_surtax_pct::float8 as surtax, dealer_fee_default::float8 as fee, tag_title_default::float8 as tag from organizations where id = $1", [orgId]);
  return { stateTaxPct: 6, surtaxPct: r.rows[0]?.surtax ?? 0, dealerFee: r.rows[0]?.fee ?? 0, tagTitleFees: r.rows[0]?.tag ?? 0 };
}

function clean(input: DealInput, d: Defaults) {
  const buyerName = input.buyerName.trim();
  if (!buyerName) throw new ValidationError("buyerName", "Enter the buyer's name as it should appear on the title.");
  if (buyerName.length > 200) throw new ValidationError("buyerName", "Keep the name under 200 characters.");
  if (!UUID.test(input.vehicleId)) throw new ValidationError("vehicleId", "Choose a vehicle.");
  if (input.customerId && !UUID.test(input.customerId)) throw new ValidationError("customerId", "Choose a customer from the list.");
  if (input.buyerDob !== undefined && input.buyerDob && !DATE.test(input.buyerDob)) throw new ValidationError("buyerDob", "Enter the date of birth as YYYY-MM-DD.");
  if (input.buyerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.buyerEmail.trim())) throw new ValidationError("buyerEmail", "Enter a valid email address.");
  const tradeVin = input.tradeVin?.trim() ? cleanVin(input.tradeVin) : null;
  if (tradeVin) {
    const problem = vinProblem(tradeVin);
    if (problem) throw new ValidationError("tradeVin", `Trade-in VIN: ${problem}`);
  }
  if (input.tradeMileage !== undefined && input.tradeMileage !== null && (!Number.isInteger(input.tradeMileage) || input.tradeMileage < 0)) throw new ValidationError("tradeMileage", "Enter the trade-in mileage as a whole number.");
  if (input.odometer !== undefined && input.odometer !== null && (!Number.isInteger(input.odometer) || input.odometer < 0 || input.odometer > 5_000_000)) throw new ValidationError("odometer", "Enter the odometer reading as a whole number.");
  if (input.odometerBrand !== undefined && !(ODOMETER_BRANDS as readonly string[]).includes(input.odometerBrand)) throw new ValidationError("odometerBrand", "Choose an odometer statement.");
  return {
    vehicleId: input.vehicleId,
    customerId: input.customerId || null,
    buyerName,
    buyerAddress: text(input.buyerAddress, 200, "buyerAddress") ?? null,
    buyerCity: text(input.buyerCity, 100, "buyerCity") ?? null,
    buyerState: (text(input.buyerState, 2, "buyerState") ?? "FL").toUpperCase(),
    buyerZip: text(input.buyerZip, 10, "buyerZip") ?? null,
    buyerPhone: text(input.buyerPhone, 40, "buyerPhone") ?? null,
    buyerEmail: text(input.buyerEmail, 200, "buyerEmail") ?? null,
    buyerDl: text(input.buyerDl, 40, "buyerDl") ?? null,
    buyerDob: input.buyerDob?.trim() || null,
    buyerSex: input.buyerSex && ["M", "F", "X"].includes(input.buyerSex.trim().toUpperCase()) ? input.buyerSex.trim().toUpperCase() : null,
    buyerCounty: text(input.buyerCounty, 60, "buyerCounty") ?? null,
    coBuyerName: text(input.coBuyerName, 200, "coBuyerName") ?? null,
    salePrice: money(input.salePrice, "salePrice"),
    dealerFee: money(input.dealerFee, "dealerFee", d.dealerFee),
    tradeAllowance: money(input.tradeAllowance, "tradeAllowance"),
    tradeVin,
    tradeDescription: text(input.tradeDescription, 200, "tradeDescription") ?? null,
    tradeMileage: input.tradeMileage ?? null,
    stateTaxPct: pct(input.stateTaxPct, "stateTaxPct", d.stateTaxPct),
    surtaxPct: pct(input.surtaxPct, "surtaxPct", d.surtaxPct),
    surtaxCap: money(input.surtaxCap, "surtaxCap", 5000),
    tagTitleFees: money(input.tagTitleFees, "tagTitleFees", d.tagTitleFees),
    otherFees: money(input.otherFees, "otherFees"),
    otherFeesNote: text(input.otherFeesNote, 200, "otherFeesNote") ?? null,
    odometer: input.odometer ?? null,
    odometerBrand: input.odometerBrand ?? "actual",
    soldAsIs: input.soldAsIs ?? true,
    warrantyNote: text(input.warrantyNote, 500, "warrantyNote") ?? null,
    notes: text(input.notes, 4000, "notes") ?? null,
  };
}

const COLUMNS = `
  d.id, d.number, d.status, d.vehicle_id as "vehicleId", v.stock_number as "stockNumber", v.vin,
  concat_ws(' ', v.year::text, v.make, v.model, v.trim) as "vehicleName", v.acquisition_price::float8 as "vehicleCost",
  d.customer_id as "customerId", d.buyer_name as "buyerName", d.buyer_address as "buyerAddress", d.buyer_city as "buyerCity", d.buyer_state as "buyerState",
  d.buyer_zip as "buyerZip", d.buyer_phone as "buyerPhone", d.buyer_email as "buyerEmail", d.buyer_dl as "buyerDl", to_char(d.buyer_dob, 'YYYY-MM-DD') as "buyerDob",
  d.buyer_sex as "buyerSex", d.buyer_county as "buyerCounty", v.title_number as "titleNumber", v.title_state as "titleState", v.colour as "vehicleColour", v.body_style as "vehicleBody", v.make as "vehicleMake", v.model as "vehicleModel", v.year as "vehicleYear",
  d.co_buyer_name as "coBuyerName", d.sale_price::float8 as "salePrice", d.dealer_fee::float8 as "dealerFee", d.trade_allowance::float8 as "tradeAllowance",
  d.trade_vin as "tradeVin", d.trade_description as "tradeDescription", d.trade_mileage as "tradeMileage",
  d.state_tax_pct::float8 as "stateTaxPct", d.surtax_pct::float8 as "surtaxPct", d.surtax_cap::float8 as "surtaxCap",
  d.tag_title_fees::float8 as "tagTitleFees", d.other_fees::float8 as "otherFees", d.other_fees_note as "otherFeesNote",
  d.odometer, d.odometer_brand as "odometerBrand", d.sold_as_is as "soldAsIs", d.warranty_note as "warrantyNote", d.notes,
  to_char(d.delivered_on, 'YYYY-MM-DD') as "deliveredOn", d.cancelled_reason as "cancelledReason", d.created_at as "createdAt",
  coalesce((select sum(p.amount) from deal_payments p where p.deal_id = d.id), 0)::float8 as paid`;
const FROM = "from deals d join vehicles v on v.org_id = d.org_id and v.id = d.vehicle_id";

type Row = Omit<Deal, keyof DealMoney | "payments" | "gross"> & { salePrice: number; dealerFee: number; tradeAllowance: number; tagTitleFees: number; otherFees: number; paid: number };

function shape(ctx: Ctx, row: Row, payments: DealPayment[]): Deal {
  const m = dealMoney(row, row.paid);
  const seeCost = ctx.role === "owner" || ctx.role === "admin" || ctx.role === "purchasing";
  return { ...row, ...m, payments, vehicleCost: seeCost ? row.vehicleCost : null, gross: seeCost && row.vehicleCost !== null ? cents(row.salePrice + row.dealerFee - row.vehicleCost) : null };
}

export async function createDeal(ctx: Ctx, input: DealInput): Promise<{ id: string; number: string }> {
  requireDeals(ctx, true);
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const c = clean(input, await defaults(tx, ctx.orgId));
    const car = await tx.query<{ status: string; mileage: number | null }>("select status, mileage from vehicles where id = $1 for update", [c.vehicleId]);
    if (!car.rows[0]) throw new StateError("Vehicle not found.");
    if (car.rows[0].status === "sold" || car.rows[0].status === "removed") throw new StateError("That vehicle is no longer on the lot.");
    const open = await tx.query<{ number: string }>("select number from deals where vehicle_id = $1 and status = 'open'", [c.vehicleId]);
    if (open.rows[0]) throw new StateError(`That vehicle already has an open deal, ${open.rows[0].number}. Finish or cancel it first.`);
    if (c.odometer === null) c.odometer = car.rows[0].mileage;
    const number = await nextNumber(tx, ctx.orgId, "deal", "DL");
    const cols = Object.keys(c);
    const snake = (k: string) => k.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
    const made = await tx.query<{ id: string }>(
      `insert into deals (org_id, number, created_by, ${cols.map(snake).join(", ")}) values ($1, $2, $3, ${cols.map((_, i) => `$${i + 4}`).join(", ")}) returning id`,
      [ctx.orgId, number, ctx.userId, ...cols.map((k) => (c as Record<string, unknown>)[k])],
    );
    await tx.query("insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after) values ($1, 'user', $2, 'deal.created', 'deal', $3, $4)", [ctx.orgId, ctx.userId, made.rows[0]!.id, JSON.stringify({ number, ...c })]);
    return { id: made.rows[0]!.id, number };
  });
}

export async function updateDeal(ctx: Ctx, id: string, input: DealInput): Promise<void> {
  requireDeals(ctx, true);
  if (!UUID.test(id)) throw new StateError("Deal not found.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const current = await tx.query<{ status: DealStatus; vehicle_id: string }>("select status, vehicle_id from deals where id = $1 for update", [id]);
    const row = current.rows[0];
    if (!row) throw new StateError("Deal not found.");
    if (row.status !== "open") throw new StateError(`A ${row.status} deal cannot be changed.`);
    const c = clean({ ...input, vehicleId: row.vehicle_id }, await defaults(tx, ctx.orgId));
    const { vehicleId: _same, ...rest } = c;
    void _same;
    const cols = Object.keys(rest);
    const snake = (k: string) => k.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
    await tx.query(`update deals set updated_at = now(), ${cols.map((k, i) => `${snake(k)} = $${i + 2}`).join(", ")} where id = $1`, [id, ...cols.map((k) => (rest as Record<string, unknown>)[k])]);
    await tx.query("insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after) values ($1, 'user', $2, 'deal.updated', 'deal', $3, $4)", [ctx.orgId, ctx.userId, id, JSON.stringify(rest)]);
  });
}

/** Money received on the deal. A person records it; the deal's balance comes down. */
export async function recordDealPayment(ctx: Ctx, id: string, input: { amount: number; method: string; reference?: string; paidOn: string }): Promise<{ paid: number; balance: number }> {
  requireDeals(ctx, true);
  if (!UUID.test(id)) throw new StateError("Deal not found.");
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new ValidationError("amount", "Enter an amount above zero.");
  if (!(PAYMENT_METHODS as readonly string[]).includes(input.method)) throw new ValidationError("method", "Choose how it was paid.");
  if (!DATE.test(input.paidOn)) throw new ValidationError("paidOn", "Enter the date as YYYY-MM-DD.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const d = await tx.query<Row>(`select ${COLUMNS} ${FROM} where d.id = $1 for update of d`, [id]);
    const row = d.rows[0];
    if (!row) throw new StateError("Deal not found.");
    if (row.status === "cancelled") throw new StateError("This deal was cancelled.");
    const before = dealMoney(row, row.paid);
    if (cents(input.amount) > before.balance + 0.005) throw new ValidationError("amount", `That is more than the ${before.balance.toFixed(2)} still owed.`);
    await tx.query("insert into deal_payments (org_id, deal_id, amount, method, reference, paid_on, recorded_by) values ($1, $2, $3, $4, $5, $6, $7)", [ctx.orgId, id, cents(input.amount), input.method, input.reference?.trim().slice(0, 100) || null, input.paidOn, ctx.userId]);
    await tx.query("insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after) values ($1, 'user', $2, 'deal.payment_recorded', 'deal', $3, $4)", [ctx.orgId, ctx.userId, id, JSON.stringify({ amount: cents(input.amount), method: input.method })]);
    const after = dealMoney(row, row.paid + cents(input.amount));
    return { paid: after.paid, balance: after.balance };
  });
}

/**
 * Delivers the deal: the buyer has paid in full, the car is theirs. The vehicle is marked sold and a
 * trade-in, if there was one, arrives on the lot as a draft with its VIN.
 */
export async function deliverDeal(ctx: Ctx, id: string, deliveredOn: string): Promise<{ tradeInId: string | null }> {
  requireDeals(ctx, true);
  if (!UUID.test(id)) throw new StateError("Deal not found.");
  if (!DATE.test(deliveredOn)) throw new ValidationError("deliveredOn", "Enter the date as YYYY-MM-DD.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const d = await tx.query<Row>(`select ${COLUMNS} ${FROM} where d.id = $1 for update of d`, [id]);
    const row = d.rows[0];
    if (!row) throw new StateError("Deal not found.");
    if (row.status !== "open") throw new StateError(`This deal is already ${row.status}.`);
    const m = dealMoney(row, row.paid);
    if (m.balance > 0.005) throw new StateError(`${m.balance.toFixed(2)} is still owed. Record the payment first; a cash sale is delivered paid in full.`);
    if (!row.buyerAddress || !row.buyerCity || !row.buyerZip) throw new StateError("The buyer's address is needed for the title paperwork before delivery.");
    if (row.odometer === null) throw new StateError("Enter the odometer reading before delivery: the odometer statement needs it.");
    await tx.query("update deals set status = 'delivered', delivered_on = $2, updated_at = now() where id = $1", [id, deliveredOn]);
    await tx.query("update vehicles set status = 'sold', sold_at = now(), updated_at = now(), mileage = coalesce($2, mileage) where id = $1", [row.vehicleId, row.odometer]);
    let tradeInId: string | null = null;
    if (row.tradeVin) {
      const live = await tx.query("select 1 from vehicles where vin = $1 and status not in ('sold', 'removed')", [row.tradeVin]);
      if (live.rowCount === 0) {
        const number = await nextNumber(tx, ctx.orgId, "vehicle", (await tx.query<{ p: string }>("select stock_number_prefix as p from organizations where id = $1", [ctx.orgId])).rows[0]?.p || "STK");
        const made = await tx.query<{ id: string }>(
          `insert into vehicles (org_id, stock_number, vin, mileage, acquisition_price, acquisition_source, acquired_on, status, notes, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9) returning id`,
          [ctx.orgId, number, row.tradeVin, row.tradeMileage, row.tradeAllowance, `Trade-in on ${row.number}`, deliveredOn, row.tradeDescription ? `Trade-in: ${row.tradeDescription}. Decode the VIN to fill in the details.` : "Trade-in. Decode the VIN to fill in the details.", ctx.userId],
        );
        tradeInId = made.rows[0]!.id;
      }
    }
    await tx.query("insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after) values ($1, 'user', $2, 'deal.delivered', 'deal', $3, $4)", [ctx.orgId, ctx.userId, id, JSON.stringify({ deliveredOn, total: m.total, tradeInId })]);
    return { tradeInId };
  });
}

export async function cancelDeal(ctx: Ctx, id: string, reason: string): Promise<void> {
  requireDeals(ctx, true);
  if (!UUID.test(id)) throw new StateError("Deal not found.");
  const why = reason.trim().slice(0, 200);
  if (!why) throw new ValidationError("reason", "Say why the deal fell through.");
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const d = await tx.query<{ status: DealStatus; paid: number }>("select status, coalesce((select sum(amount) from deal_payments p where p.deal_id = d.id), 0)::float8 as paid from deals d where id = $1 for update", [id]);
    const row = d.rows[0];
    if (!row) throw new StateError("Deal not found.");
    if (row.status !== "open") throw new StateError(`This deal is already ${row.status}.`);
    await tx.query("update deals set status = 'cancelled', cancelled_reason = $2, updated_at = now() where id = $1", [id, why]);
    await tx.query("insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after) values ($1, 'user', $2, 'deal.cancelled', 'deal', $3, $4)", [ctx.orgId, ctx.userId, id, JSON.stringify({ reason: why, refundDue: row.paid })]);
  });
}

export async function getDeal(ctx: Ctx, id: string): Promise<Deal | null> {
  requireDeals(ctx, false);
  if (!UUID.test(id)) return null;
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const d = await tx.query<Row>(`select ${COLUMNS} ${FROM} where d.id = $1`, [id]);
    const row = d.rows[0];
    if (!row) return null;
    const p = await tx.query<DealPayment>(
      `select p.id, p.amount::float8 as amount, p.method, p.reference, to_char(p.paid_on, 'YYYY-MM-DD') as "paidOn", u.name as "recordedBy"
         from deal_payments p left join users u on u.id = p.recorded_by where p.deal_id = $1 order by p.paid_on, p.created_at`,
      [id],
    );
    return shape(ctx, row, p.rows);
  });
}

export async function listDeals(ctx: Ctx, options: { status?: DealStatus; search?: string } = {}): Promise<DealSummary[]> {
  requireDeals(ctx, false);
  const search = options.search?.trim().slice(0, 80) ?? "";
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const d = await tx.query<Row>(
      `select ${COLUMNS} ${FROM}
        where ($1::text is null or d.status = $1)
          and ($2 = '' or d.number ilike '%' || $2 || '%' or d.buyer_name ilike '%' || $2 || '%' or v.stock_number ilike '%' || $2 || '%' or v.vin ilike '%' || $2 || '%')
        order by (d.status <> 'open'), d.created_at desc`,
      [options.status ?? null, search],
    );
    return d.rows.map((row) => {
      const m = dealMoney(row, row.paid);
      return { id: row.id, number: row.number, status: row.status, stockNumber: row.stockNumber, vehicleName: row.vehicleName, buyerName: row.buyerName, total: m.total, balance: m.balance, deliveredOn: row.deliveredOn, createdAt: row.createdAt };
    });
  });
}

/** The open deal on a vehicle, if any: the vehicle page links to it. */
export async function openDealFor(ctx: Ctx, vehicleId: string): Promise<{ id: string; number: string } | null> {
  requireDeals(ctx, false);
  if (!UUID.test(vehicleId)) return null;
  const r = await withTenant(ctx.pool, ctx.orgId, (tx) => tx.query<{ id: string; number: string }>("select id, number from deals where vehicle_id = $1 and status = 'open'", [vehicleId]));
  return r.rows[0] ?? null;
}

export type DealerSettings = { licence: string | null; county: string | null; surtaxPct: number; dealerFee: number; tagTitleFees: number; stockNumberStyle: "counter" | "vin6"; stockNumberPrefix: string };

export async function getDealerSettings(ctx: Ctx): Promise<DealerSettings> {
  requireDeals(ctx, false);
  const r = await withTenant(ctx.pool, ctx.orgId, (tx) =>
    tx.query<DealerSettings>(
      `select dealer_licence as licence, dealer_county as county, county_surtax_pct::float8 as "surtaxPct", dealer_fee_default::float8 as "dealerFee",
              tag_title_default::float8 as "tagTitleFees", stock_number_style as "stockNumberStyle", stock_number_prefix as "stockNumberPrefix"
         from organizations where id = $1`,
      [ctx.orgId],
    ),
  );
  return r.rows[0]!;
}

export async function updateDealerSettings(ctx: Ctx, input: Partial<DealerSettings>): Promise<void> {
  requirePermission(ctx, "settings.manage");
  if (!featureOn(ctx.features, "dealer")) throw new ForbiddenError("settings.manage");
  const licence = text(input.licence ?? undefined, 40, "licence");
  const county = text(input.county ?? undefined, 60, "county");
  const surtaxPct = input.surtaxPct === undefined ? undefined : pct(input.surtaxPct, "surtaxPct", 0);
  const dealerFee = input.dealerFee === undefined ? undefined : money(input.dealerFee, "dealerFee");
  const tagTitleFees = input.tagTitleFees === undefined ? undefined : money(input.tagTitleFees, "tagTitleFees");
  if (input.stockNumberStyle !== undefined && input.stockNumberStyle !== "counter" && input.stockNumberStyle !== "vin6") throw new ValidationError("stockNumberStyle", "Choose a stock number style.");
  const prefix = input.stockNumberPrefix === undefined ? undefined : input.stockNumberPrefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "STK";
  await withTenant(ctx.pool, ctx.orgId, (tx) =>
    tx.query(
      `update organizations set dealer_licence = coalesce($2, dealer_licence), dealer_county = coalesce($3, dealer_county), county_surtax_pct = coalesce($4, county_surtax_pct),
              dealer_fee_default = coalesce($5, dealer_fee_default), tag_title_default = coalesce($6, tag_title_default),
              stock_number_style = coalesce($7, stock_number_style), stock_number_prefix = coalesce($8, stock_number_prefix), updated_at = now()
        where id = $1`,
      [ctx.orgId, licence, county, surtaxPct, dealerFee, tagTitleFees, input.stockNumberStyle ?? null, prefix ?? null],
    ),
  );
}

/**
 * Sales for the dealer's Home chart: the last 30 days, this quarter, or this year so far. A sale counts
 * on the day its deal was delivered, at the sale price (before tax, fees and trade-in), cancelled deals left out.
 */
export async function dealSalesSeries(ctx: Ctx, period: "30d" | "quarter" | "ytd"): Promise<{ period: "30d" | "quarter" | "ytd"; bucket: "day" | "week"; points: { date: string; total: number }[]; total: number; cars: number; from: string; to: string } | null> {
  if (!featureOn(ctx.features, "dealer")) return null;
  requirePermission(ctx, "vehicle.read");
  const zone = (await withTenant(ctx.pool, ctx.orgId, (tx) => tx.query<{ tz: string }>("select timezone as tz from organizations where id = $1", [ctx.orgId]))).rows[0]?.tz ?? "UTC";
  const start =
    period === "30d" ? "(now() at time zone $1)::date - 29"
    : period === "quarter" ? "date_trunc('quarter', now() at time zone $1)::date"
    : "date_trunc('year', now() at time zone $1)::date";
  const weekly = period === "ytd";
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<{ date: string; total: number; cars: number; first: string; last: string }>(
      `with span as (select ${start} as first, (now() at time zone $1)::date as last),
            days as (select generate_series(first, last, interval '1 day')::date as day from span),
            daily as (select d.day,
                             coalesce((select sum(sale_price) from deals x where x.status = 'delivered' and x.delivered_on = d.day), 0) as total,
                             (select count(*) from deals x where x.status = 'delivered' and x.delivered_on = d.day) as cars
                        from days d)
       select to_char(min(day), 'YYYY-MM-DD') as date, sum(total)::float8 as total, sum(cars)::int as cars,
              to_char((select first from span), 'YYYY-MM-DD') as first, to_char((select last from span), 'YYYY-MM-DD') as last
         from daily
        group by ${weekly ? "date_trunc('week', day)" : "day"}
        order by 1`,
      [zone],
    );
    const points = result.rows.map(({ date, total }) => ({ date, total }));
    return {
      period,
      bucket: weekly ? "week" : "day",
      points,
      total: points.reduce((sum, p) => sum + p.total, 0),
      cars: result.rows.reduce((sum, r) => sum + r.cars, 0),
      from: result.rows[0]!.first,
      to: result.rows[0]!.last,
    };
  });
}
