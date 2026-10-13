import { withTenant, type PoolClient } from "@bos/db/runtime";
import type { Ctx } from "../platform/context";
import { StateError, ValidationError } from "../platform/errors";
import { featureOn } from "../platform/features";
import { parseCsv } from "../platform/importing";
import { ForbiddenError, requirePermission } from "../platform/permissions";
import { nextNumber } from "../sales/orders";
import { cleanVin, decodeVin, DecodeError, SPEC_FIELDS, vinProblem, vpicDecoder, type Decoded, type VehicleSpecs, type VinDecoder } from "./vin";

/**
 * Dealer Terminal: one record per car. A vehicle starts from its VIN, which the decoder turns into
 * specifications; the dealer adds what only they know (mileage, cost, condition) and the record
 * tracks the car from arrival to sale.
 */

export const VEHICLE_STATUSES = ["draft", "recon", "on_lot", "sold", "removed"] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];
export const STATUS_TEXT: Record<VehicleStatus, string> = { draft: "Draft", recon: "In reconditioning", on_lot: "On the lot", sold: "Sold", removed: "Removed" };
export const CONDITIONS = ["Excellent", "Good", "Fair", "Poor", "Salvage"] as const;
export const isVehicleStatus = (v: unknown): v is VehicleStatus => (VEHICLE_STATUSES as readonly unknown[]).includes(v);

/** What the dealer adds by hand. Nothing here comes from the VIN. */
export type VehicleOwnInput = {
  colour?: string;
  mileage?: number;
  condition?: string;
  acquisitionPrice?: number;
  acquisitionSource?: string;
  acquiredOn?: string;
  askingPrice?: number;
  locationId?: string;
  status?: VehicleStatus;
  notes?: string;
  description?: string;
  titleNumber?: string;
  titleState?: string;
  titleIssuedOn?: string;
};

export type Vehicle = VehicleSpecs & VehicleOwnInput & {
  id: string;
  stockNumber: string;
  vin: string | null;
  specs: Record<string, string>;
  provenance: Record<string, "decoder" | "manual">;
  status: VehicleStatus;
  locationName: string | null;
  createdAt: Date;
  soldAt: Date | null;
  /** Days since the record was made (or since it went on the lot, once it has). */
  daysHeld: number;
};

export type VehicleSummary = Pick<Vehicle, "id" | "stockNumber" | "vin" | "year" | "make" | "model" | "trim" | "mileage" | "askingPrice" | "acquisitionPrice" | "status" | "daysHeld" | "colour">;

/** What the dealer sees before a record exists: the decoded car, and anything that stands in the way. */
export type VinLookup = {
  vin: string;
  decoded: Decoded | null;
  /** The live record that already has this VIN, if any. */
  duplicate: { id: string; stockNumber: string; status: VehicleStatus } | null;
  /** Specification fields the decoder could not fill. */
  missing: (keyof VehicleSpecs)[];
  /** The decoder's own doubts, plus why it could not decode at all. */
  warnings: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COLUMNS = `
  v.id, v.stock_number as "stockNumber", v.vin, v.year, v.make, v.model, v.trim, v.body_style as "bodyStyle", v.engine,
  v.displacement_l::float8 as "displacementL", v.cylinders, v.horsepower, v.transmission, v.drivetrain, v.fuel_type as "fuelType",
  v.category, v.manufacturer, v.doors, v.cab, v.bed_length as "bedLength", v.made_in as "madeIn", v.specs, v.provenance,
  v.colour, v.mileage, v.condition, v.acquisition_price::float8 as "acquisitionPrice", v.acquisition_source as "acquisitionSource",
  to_char(v.acquired_on, 'YYYY-MM-DD') as "acquiredOn", v.asking_price::float8 as "askingPrice", v.location_id as "locationId",
  l.name as "locationName", v.status, v.description, v.notes, v.created_at as "createdAt", v.sold_at as "soldAt",
  v.title_number as "titleNumber", v.title_state as "titleState", to_char(v.title_issued_on, 'YYYY-MM-DD') as "titleIssuedOn",
  extract(day from coalesce(v.sold_at, now()) - v.created_at)::int as "daysHeld"`;
const FROM = "from vehicles v left join locations l on l.org_id = v.org_id and l.id = v.location_id";

function requireDealer(ctx: Ctx, write: boolean): void {
  requirePermission(ctx, write ? "vehicle.write" : "vehicle.read");
  if (!featureOn(ctx.features, "dealer")) throw new ForbiddenError(write ? "vehicle.write" : "vehicle.read");
}

/** The decoder in use. Swap it for a commercial one by setting a different implementation here. */
let decoder: VinDecoder = vpicDecoder();
export function useVinDecoder(next: VinDecoder): void {
  decoder = next;
}

/** Validates a VIN, looks for a live record with it, and decodes it. Nothing is saved. */
export async function lookupVin(ctx: Ctx, input: string): Promise<VinLookup> {
  requireDealer(ctx, true);
  const vin = cleanVin(input);
  const problem = vinProblem(vin);
  if (problem) throw new ValidationError("vin", problem);
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const dup = await tx.query<{ id: string; stockNumber: string; status: VehicleStatus }>(
      `select id, stock_number as "stockNumber", status from vehicles where vin = $1 and status not in ('sold', 'removed')`,
      [vin],
    );
    let decoded: Decoded | null = null;
    const warnings: string[] = [];
    try {
      decoded = await decodeVin(tx, decoder, vin);
      warnings.push(...decoded.warnings);
    } catch (error) {
      if (!(error instanceof DecodeError)) throw error;
      warnings.push(`${error.message} You can still add the car and type its details.`);
    }
    const missing = SPEC_FIELDS.filter((f) => decoded?.specs[f] === undefined);
    return { vin, decoded, duplicate: dup.rows[0] ?? null, missing, warnings };
  });
}

function cleanOwn(input: VehicleOwnInput): VehicleOwnInput {
  const out: VehicleOwnInput = {};
  const text = (v: string | undefined, max: number, field: string) => {
    if (v === undefined) return undefined;
    const t = v.trim();
    if (t.length > max) throw new ValidationError(field, `Keep this under ${max} characters.`);
    return t || undefined;
  };
  const money = (v: number | undefined, field: string) => {
    if (v === undefined) return undefined;
    if (!Number.isFinite(v) || v < 0 || v > 1e9) throw new ValidationError(field, "Enter an amount of zero or more.");
    return Math.round(v * 100) / 100;
  };
  out.colour = text(input.colour, 40, "colour");
  if (input.mileage !== undefined) {
    if (!Number.isInteger(input.mileage) || input.mileage < 0 || input.mileage > 5_000_000) throw new ValidationError("mileage", "Enter the mileage as a whole number.");
    out.mileage = input.mileage;
  }
  out.condition = text(input.condition, 40, "condition");
  out.acquisitionPrice = money(input.acquisitionPrice, "acquisitionPrice");
  out.acquisitionSource = text(input.acquisitionSource, 120, "acquisitionSource");
  if (input.acquiredOn !== undefined) {
    if (input.acquiredOn && !DATE.test(input.acquiredOn)) throw new ValidationError("acquiredOn", "Enter the date as YYYY-MM-DD.");
    out.acquiredOn = input.acquiredOn || undefined;
  }
  out.askingPrice = money(input.askingPrice, "askingPrice");
  if (input.locationId !== undefined) {
    if (input.locationId && !UUID.test(input.locationId)) throw new ValidationError("locationId", "Choose a location from the list.");
    out.locationId = input.locationId || undefined;
  }
  if (input.status !== undefined) {
    if (!isVehicleStatus(input.status)) throw new ValidationError("status", "Choose a status from the list.");
    out.status = input.status;
  }
  out.notes = text(input.notes, 4000, "notes");
  out.description = text(input.description, 4000, "description");
  out.titleNumber = text(input.titleNumber, 40, "titleNumber");
  if (input.titleState !== undefined) out.titleState = (text(input.titleState, 2, "titleState") ?? "FL").toUpperCase();
  if (input.titleIssuedOn !== undefined) {
    if (input.titleIssuedOn && !DATE.test(input.titleIssuedOn)) throw new ValidationError("titleIssuedOn", "Enter the date as YYYY-MM-DD.");
    out.titleIssuedOn = input.titleIssuedOn || undefined;
  }
  return out;
}

function cleanSpecs(input: Partial<VehicleSpecs>): VehicleSpecs {
  const out: VehicleSpecs = {};
  for (const field of SPEC_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null || value === "") continue;
    if (field === "year" || field === "cylinders" || field === "horsepower" || field === "doors") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > (field === "year" ? 2100 : 10000)) throw new ValidationError(field, "Enter a whole number.");
      (out as Record<string, unknown>)[field] = n;
    } else if (field === "displacementL") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 99) throw new ValidationError(field, "Enter the displacement in litres.");
      out.displacementL = Math.round(n * 10) / 10;
    } else {
      const t = String(value).trim().slice(0, 120);
      if (t) (out as Record<string, unknown>)[field] = t;
    }
  }
  return out;
}

async function stockNumber(tx: PoolClient, orgId: string, vin: string | null): Promise<string> {
  const org = await tx.query<{ style: string; prefix: string }>("select stock_number_style as style, stock_number_prefix as prefix from organizations where id = $1", [orgId]);
  const style = org.rows[0]?.style ?? "counter";
  const prefix = org.rows[0]?.prefix?.trim() || "STK";
  if (style === "vin6" && vin) {
    // The last six of the VIN, with a suffix if the lot has seen that car before.
    const base = vin.slice(-6);
    for (let n = 0; n < 20; n++) {
      const candidate = n === 0 ? base : `${base}-${n + 1}`;
      const taken = await tx.query("select 1 from vehicles where org_id = $1 and stock_number = $2", [orgId, candidate]);
      if (taken.rowCount === 0) return candidate;
    }
  }
  return nextNumber(tx, orgId, "vehicle", prefix);
}

const SPEC_COLUMN: Record<keyof VehicleSpecs, string> = {
  year: "year", make: "make", model: "model", trim: "trim", bodyStyle: "body_style", engine: "engine", displacementL: "displacement_l", cylinders: "cylinders",
  horsepower: "horsepower", transmission: "transmission", drivetrain: "drivetrain", fuelType: "fuel_type", category: "category", manufacturer: "manufacturer",
  doors: "doors", cab: "cab", bedLength: "bed_length", madeIn: "made_in",
};
const OWN_COLUMN: Record<keyof VehicleOwnInput, string> = {
  colour: "colour", mileage: "mileage", condition: "condition", acquisitionPrice: "acquisition_price", acquisitionSource: "acquisition_source", acquiredOn: "acquired_on",
  askingPrice: "asking_price", locationId: "location_id", status: "status", notes: "notes", description: "description",
  titleNumber: "title_number", titleState: "title_state", titleIssuedOn: "title_issued_on",
};

/**
 * Creates the record. `specs` is what the dealer approved on the review screen: fields the decoder
 * filled are marked as the decoder's, anything they typed or changed is marked manual.
 */
export async function createVehicle(
  ctx: Ctx,
  input: { vin?: string; specs: Partial<VehicleSpecs>; own?: VehicleOwnInput },
): Promise<{ id: string; stockNumber: string }> {
  requireDealer(ctx, true);
  const vin = input.vin?.trim() ? cleanVin(input.vin) : null;
  if (vin) {
    const problem = vinProblem(vin);
    if (problem) throw new ValidationError("vin", problem);
  }
  const specs = cleanSpecs(input.specs);
  const own = cleanOwn(input.own ?? {});
  if (!vin && !specs.make && !specs.model) throw new ValidationError("vin", "Enter a VIN, or at least the make and model.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    if (vin) {
      const dup = await tx.query<{ stock_number: string }>("select stock_number from vehicles where vin = $1 and status not in ('sold', 'removed')", [vin]);
      if (dup.rows[0]) throw new StateError(`That VIN is already on the lot as ${dup.rows[0].stock_number}.`);
    }
    // Provenance: a field that matches what the decoder said is the decoder's; anything else was typed.
    const known = vin ? (await tx.query<{ fields: { specs: VehicleSpecs; extra: Record<string, string> } }>("select fields from vin_decodes where vin = $1", [vin])).rows[0]?.fields : undefined;
    const provenance: Record<string, "decoder" | "manual"> = {};
    for (const field of Object.keys(specs) as (keyof VehicleSpecs)[]) provenance[field] = known?.specs[field] === specs[field] ? "decoder" : "manual";
    const extra = known?.extra ?? {};
    // The dealership's main location unless told otherwise.
    if (own.locationId === undefined) {
      const main = await tx.query<{ id: string }>("select id from locations where is_active order by created_at, id limit 1");
      if (main.rows[0]) own.locationId = main.rows[0].id;
    }
    const number = await stockNumber(tx, ctx.orgId, vin);
    const columns = ["org_id", "stock_number", "vin", "specs", "provenance", "created_by"];
    const values: unknown[] = [ctx.orgId, number, vin, JSON.stringify(extra), JSON.stringify(provenance), ctx.userId];
    for (const [field, column] of Object.entries(SPEC_COLUMN) as [keyof VehicleSpecs, string][]) if (specs[field] !== undefined) { columns.push(column); values.push(specs[field]); }
    for (const [field, column] of Object.entries(OWN_COLUMN) as [keyof VehicleOwnInput, string][]) if (own[field] !== undefined) { columns.push(column); values.push(own[field]); }
    const made = await tx.query<{ id: string }>(
      `insert into vehicles (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      values,
    );
    const id = made.rows[0]!.id;
    await tx.query(
      "insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after) values ($1, 'user', $2, 'vehicle.created', 'vehicle', $3, $4)",
      [ctx.orgId, ctx.userId, id, JSON.stringify({ stockNumber: number, vin, ...specs, ...own })],
    );
    return { id, stockNumber: number };
  });
}

export async function listVehicles(ctx: Ctx, options: { status?: VehicleStatus | "live"; search?: string } = {}): Promise<VehicleSummary[]> {
  requireDealer(ctx, false);
  const search = options.search?.trim().slice(0, 80) ?? "";
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<VehicleSummary>(
      `select ${COLUMNS} ${FROM}
        where ($1::text is null or ($1 = 'live' and v.status not in ('sold', 'removed')) or v.status = $1)
          and ($2 = '' or v.vin ilike '%' || $2 || '%' or v.stock_number ilike '%' || $2 || '%'
               or concat_ws(' ', v.year::text, v.make, v.model, v.trim, v.colour) ilike '%' || $2 || '%')
        order by case v.status when 'draft' then 0 when 'recon' then 1 when 'on_lot' then 2 when 'sold' then 3 else 4 end, v.created_at desc`,
      [options.status ?? null, search],
    );
    return result.rows;
  });
}

export async function getVehicle(ctx: Ctx, id: string): Promise<Vehicle | null> {
  requireDealer(ctx, false);
  if (!UUID.test(id)) return null;
  const result = await withTenant(ctx.pool, ctx.orgId, (tx) => tx.query<Vehicle>(`select ${COLUMNS} ${FROM} where v.id = $1`, [id]));
  return result.rows[0] ?? null;
}

/** Changes the dealer's own fields and, when given, the specifications (which then count as typed by hand). A VIN can be added to a car that had none. */
export async function updateVehicle(ctx: Ctx, id: string, input: { own?: VehicleOwnInput; specs?: Partial<VehicleSpecs>; vin?: string }): Promise<void> {
  requireDealer(ctx, true);
  if (!UUID.test(id)) throw new StateError("Vehicle not found.");
  const own = cleanOwn(input.own ?? {});
  const specs = input.specs ? cleanSpecs(input.specs) : undefined;
  const vin = input.vin?.trim() ? cleanVin(input.vin) : null;
  if (vin) {
    const problem = vinProblem(vin);
    if (problem) throw new ValidationError("vin", problem);
  }
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const current = await tx.query<{ status: VehicleStatus; provenance: Record<string, string>; vin: string | null }>("select status, provenance, vin from vehicles where id = $1 for update", [id]);
    const row = current.rows[0];
    if (!row) throw new StateError("Vehicle not found.");
    const sets: string[] = ["updated_at = now()"];
    const values: unknown[] = [id];
    const set = (column: string, value: unknown) => { values.push(value); sets.push(`${column} = $${values.length}`); };
    if (vin && !row.vin) {
      const dup = await tx.query<{ stock_number: string }>("select stock_number from vehicles where vin = $1 and status not in ('sold', 'removed') and id <> $2", [vin, id]);
      if (dup.rows[0]) throw new StateError(`That VIN is already on the lot as ${dup.rows[0].stock_number}.`);
      set("vin", vin);
    }
    for (const [field, column] of Object.entries(OWN_COLUMN) as [keyof VehicleOwnInput, string][]) {
      if (!(field in (input.own ?? {}))) continue;
      set(column, own[field] ?? null);
    }
    if (own.status === "sold" && row.status !== "sold") set("sold_at", new Date());
    if (own.status && own.status !== "sold" && row.status === "sold") set("sold_at", null);
    if (specs) {
      const provenance = { ...row.provenance };
      for (const [field, column] of Object.entries(SPEC_COLUMN) as [keyof VehicleSpecs, string][]) {
        if (!(field in input.specs!)) continue;
        set(column, specs[field] ?? null);
        if (specs[field] === undefined) delete provenance[field];
        else provenance[field] = "manual";
      }
      set("provenance", JSON.stringify(provenance));
    }
    await tx.query(`update vehicles set ${sets.join(", ")} where id = $1`, values);
    await tx.query(
      "insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after) values ($1, 'user', $2, 'vehicle.updated', 'vehicle', $3, $4)",
      [ctx.orgId, ctx.userId, id, JSON.stringify({ ...own, ...(specs ?? {}) })],
    );
  });
}

/** One row of a bulk import, after the VIN has been checked and decoded. */
export type VehicleImportRow = {
  row: number;
  vin: string;
  given: string;
  /** Columns the file had beyond the VIN, read as the dealer's own fields. */
  own: VehicleOwnInput;
  lookup: VinLookup | null;
  /** Why this row will be skipped. Null when it will be imported. */
  problem: string | null;
  summary: string;
};

const OWN_HEADERS: Record<string, keyof VehicleOwnInput> = {
  mileage: "mileage", miles: "mileage", odometer: "mileage", colour: "colour", color: "colour", condition: "condition",
  cost: "acquisitionPrice", acquisition_price: "acquisitionPrice", "acquisition price": "acquisitionPrice", purchase_price: "acquisitionPrice",
  source: "acquisitionSource", acquisition_source: "acquisitionSource", "acquired from": "acquisitionSource",
  acquired_on: "acquiredOn", "acquired on": "acquiredOn", purchased: "acquiredOn", price: "askingPrice", asking: "askingPrice", asking_price: "askingPrice",
  notes: "notes",
};

/** Reads a CSV of VINs (one per row, a header with "vin" in it optional), decodes each, and says what would happen. */
export async function planVehicleImport(ctx: Ctx, text: string): Promise<{ rows: VehicleImportRow[]; ready: number }> {
  requireDealer(ctx, true);
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim()));
  if (table.length === 0) throw new ValidationError("file", "The file is empty.");
  if (table.length > 501) throw new ValidationError("file", "Import at most 500 vehicles at a time.");
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const vinCol = header.findIndex((h) => h === "vin" || h.includes("vin"));
  const hasHeader = vinCol >= 0 || header.some((h) => h in OWN_HEADERS);
  const body = hasHeader ? table.slice(1) : table;
  const vinAt = vinCol >= 0 ? vinCol : 0;
  const rows: VehicleImportRow[] = [];
  const seen = new Set<string>();
  for (const [i, cells] of body.entries()) {
    const given = (cells[vinAt] ?? "").trim();
    const vin = cleanVin(given);
    const own: VehicleOwnInput = {};
    if (hasHeader) {
      for (const [c, h] of header.entries()) {
        const field = OWN_HEADERS[h];
        const value = (cells[c] ?? "").trim();
        if (!field || !value) continue;
        if (field === "mileage") own.mileage = Math.round(Number(value.replace(/[^\d.]/g, "")));
        else if (field === "acquisitionPrice" || field === "askingPrice") own[field] = Number(value.replace(/[^\d.-]/g, ""));
        else (own as Record<string, unknown>)[field] = value;
      }
    }
    const row: VehicleImportRow = { row: i + (hasHeader ? 2 : 1), vin, given, own, lookup: null, problem: null, summary: "" };
    const problem = vinProblem(vin);
    if (!given) row.problem = "No VIN on this row.";
    else if (problem) row.problem = problem;
    else if (seen.has(vin)) row.problem = "This VIN appears earlier in the file.";
    else {
      seen.add(vin);
      try {
        cleanOwn(own);
        row.lookup = await lookupVin(ctx, vin);
        if (row.lookup.duplicate) row.problem = `Already on the lot as ${row.lookup.duplicate.stockNumber}.`;
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        row.problem = error.message;
      }
    }
    const s = row.lookup?.decoded?.specs;
    row.summary = s ? [s.year, s.make, s.model, s.trim].filter(Boolean).join(" ") || "Decoded, but no make or model came back" : row.lookup ? "Could not be decoded; will be added with the VIN only" : "";
    rows.push(row);
  }
  return { rows, ready: rows.filter((r) => !r.problem).length };
}

/** Creates the rows the plan found ready. Rows are decoded from the cache, so this is quick. */
export async function runVehicleImport(ctx: Ctx, text: string): Promise<{ added: { id: string; stockNumber: string; vin: string }[]; skipped: number }> {
  const plan = await planVehicleImport(ctx, text);
  const added: { id: string; stockNumber: string; vin: string }[] = [];
  for (const row of plan.rows) {
    if (row.problem) continue;
    const made = await createVehicle(ctx, { vin: row.vin, specs: row.lookup?.decoded?.specs ?? {}, own: row.own });
    added.push({ ...made, vin: row.vin });
  }
  return { added, skipped: plan.rows.length - added.length };
}

/** Counts for the lot: what is where, and what is getting old. */
export async function lotSummary(ctx: Ctx): Promise<{ live: number; onLot: number; recon: number; draft: number; aged: number; invested: number | null }> {
  requireDealer(ctx, false);
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const r = await tx.query<{ live: number; on_lot: number; recon: number; draft: number; aged: number; invested: number }>(
      `select count(*) filter (where status not in ('sold', 'removed'))::int as live,
              count(*) filter (where status = 'on_lot')::int as on_lot,
              count(*) filter (where status = 'recon')::int as recon,
              count(*) filter (where status = 'draft')::int as draft,
              count(*) filter (where status not in ('sold', 'removed') and created_at < now() - interval '60 days')::int as aged,
              coalesce(sum(acquisition_price) filter (where status not in ('sold', 'removed')), 0)::float8 as invested
         from vehicles`,
    );
    const row = r.rows[0]!;
    return { live: row.live, onLot: row.on_lot, recon: row.recon, draft: row.draft, aged: row.aged, invested: ctx.role === "owner" || ctx.role === "admin" || ctx.role === "purchasing" ? row.invested : null };
  });
}
