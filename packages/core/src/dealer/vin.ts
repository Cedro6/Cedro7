import type { PoolClient } from "@bos/db/runtime";

/**
 * VIN decoding. A VIN says what a car was built as; it says nothing about its title, owner,
 * condition, accidents or mileage, and nothing here pretends otherwise. Decoders are swappable:
 * the free NHTSA vPIC service is the default, and a commercial one can take its place by
 * implementing the same shape. Results are cached by VIN, raw response included.
 */

/** The specification fields a decoder may fill. Anything it cannot say is left out, never guessed. */
export type VehicleSpecs = {
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  bodyStyle?: string;
  engine?: string;
  displacementL?: number;
  cylinders?: number;
  horsepower?: number;
  transmission?: string;
  drivetrain?: string;
  fuelType?: string;
  category?: string;
  manufacturer?: string;
  doors?: number;
  cab?: string;
  bedLength?: string;
  madeIn?: string;
};
export const SPEC_FIELDS = ["year", "make", "model", "trim", "bodyStyle", "engine", "displacementL", "cylinders", "horsepower", "transmission", "drivetrain", "fuelType", "category", "manufacturer", "doors", "cab", "bedLength", "madeIn"] as const satisfies readonly (keyof VehicleSpecs)[];

export type Decoded = {
  provider: string;
  specs: VehicleSpecs;
  /** Every other non-empty field the decoder returned, by its own names. */
  extra: Record<string, string>;
  /** The decoder's own warnings, in its words. Empty when it was sure. */
  warnings: string[];
  raw: unknown;
};

export type VinDecoder = { name: string; decode: (vin: string) => Promise<Decoded> };

const LETTER: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** Upper-case, without spaces or dashes, with the easy slips fixed (a VIN never holds I, O or Q). */
export function cleanVin(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, "").replace(/I/g, "1").replace(/O/g, "0").replace(/Q/g, "0").slice(0, 17);
}

/** Why a VIN cannot be right, or null when it passes the North American check digit. */
export function vinProblem(vin: string): string | null {
  if (vin.length !== 17) return `A VIN has 17 characters; this one has ${vin.length}.`;
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return "A VIN uses only letters and digits, and never I, O or Q.";
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i]!;
    const value = /\d/.test(ch) ? Number(ch) : LETTER[ch]!;
    sum += value * WEIGHTS[i]!;
  }
  const check = sum % 11;
  const expected = check === 10 ? "X" : String(check);
  // The check digit is a North American rule; a VIN from elsewhere can fail it and still be real.
  if (vin[8] !== expected && /^[1-5]/.test(vin)) return "The check digit does not match: one character is probably mistyped.";
  return null;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown) => {
  const n = Number(text(v));
  return text(v) && Number.isFinite(n) ? n : undefined;
};
const int = (v: unknown) => {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n);
};

/** Turns one vPIC "DecodeVinValues" row into our fields. Exported so it can be tested without the network. */
export function fromVpic(row: Record<string, unknown>): Omit<Decoded, "raw" | "provider"> {
  const s = (k: string) => text(row[k]) || undefined;
  const engineParts = [s("EngineModel"), s("EngineConfiguration"), s("EngineManufacturer")].filter(Boolean);
  const specs: VehicleSpecs = {
    year: int(row.ModelYear),
    make: titleCase(s("Make")),
    model: s("Model"),
    trim: s("Trim") ?? s("Series"),
    bodyStyle: s("BodyClass"),
    engine: engineParts.length ? engineParts.join(" ") : undefined,
    displacementL: num(row.DisplacementL) === undefined ? undefined : Math.round(num(row.DisplacementL)! * 10) / 10,
    cylinders: int(row.EngineCylinders),
    horsepower: int(row.EngineHP),
    transmission: s("TransmissionStyle"),
    drivetrain: s("DriveType"),
    fuelType: s("FuelTypePrimary"),
    category: s("VehicleType"),
    manufacturer: s("Manufacturer"),
    doors: int(row.Doors),
    cab: s("CabType"),
    bedLength: s("BedLengthIN") ? `${s("BedLengthIN")} in` : undefined,
    madeIn: s("PlantCountry"),
  };
  for (const key of Object.keys(specs) as (keyof VehicleSpecs)[]) if (specs[key] === undefined) delete specs[key];
  const used = new Set(["ModelYear", "Make", "Model", "Trim", "Series", "BodyClass", "EngineModel", "EngineConfiguration", "EngineManufacturer", "DisplacementL", "EngineCylinders", "EngineHP", "TransmissionStyle", "DriveType", "FuelTypePrimary", "VehicleType", "Manufacturer", "Doors", "CabType", "BedLengthIN", "PlantCountry", "ErrorCode", "ErrorText", "AdditionalErrorText", "VIN", "SuggestedVIN"]);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) if (!used.has(k) && text(v) && !/^\d+$/.test(k)) extra[k] = text(v);
  const warnings: string[] = [];
  const code = text(row.ErrorCode);
  // vPIC's code 0 means a clean decode; anything else comes with a sentence saying what it was unsure about.
  if (code && code !== "0") for (const line of [text(row.ErrorText), text(row.AdditionalErrorText)]) if (line) warnings.push(line.replace(/^\d+\s*-\s*/, ""));
  return { specs, extra, warnings };
}

function titleCase(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // vPIC shouts makes in capitals; short ones (BMW, GMC, RAM) stay as they are.
  return value.length <= 3 ? value : value.toLowerCase().replace(/(^|[\s-])\S/g, (c) => c.toUpperCase());
}

/** The free decoder from the US Department of Transportation. No key, no account. */
export function vpicDecoder(fetchImpl: typeof fetch = fetch, base = process.env.VPIC_BASE_URL || "https://vpic.nhtsa.dot.gov/api/vehicles"): VinDecoder {
  return {
    name: "vpic",
    decode: async (vin) => {
      let last: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetchImpl(`${base}/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`, { signal: AbortSignal.timeout(12_000) });
          if (response.status >= 500) throw new Error(`vPIC answered ${response.status}`);
          if (!response.ok) throw new DecodeError(`The VIN decoder refused the request (${response.status}).`);
          const body = (await response.json()) as { Results?: Record<string, unknown>[] };
          const row = body.Results?.[0];
          if (!row) throw new DecodeError("The VIN decoder sent back nothing for that VIN.");
          return { provider: "vpic", raw: body, ...fromVpic(row) };
        } catch (error) {
          if (error instanceof DecodeError) throw error;
          last = error;
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      throw new DecodeError(`The VIN decoder could not be reached. ${last instanceof Error ? last.message : ""}`.trim());
    },
  };
}

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

/** Decodes through the cache: the same VIN is only ever sent to the decoder once. */
export async function decodeVin(tx: PoolClient, decoder: VinDecoder, vin: string): Promise<Decoded> {
  const cached = await tx.query<{ provider: string; fields: Omit<Decoded, "raw" | "provider">; raw: unknown }>("select provider, fields, raw from vin_decodes where vin = $1", [vin]);
  if (cached.rows[0]) return { provider: cached.rows[0].provider, raw: cached.rows[0].raw, ...cached.rows[0].fields };
  const decoded = await decoder.decode(vin);
  const { raw, provider, ...fields } = decoded;
  await tx.query(
    "insert into vin_decodes (vin, provider, fields, raw) values ($1, $2, $3, $4) on conflict (vin) do update set provider = excluded.provider, fields = excluded.fields, raw = excluded.raw, fetched_at = now()",
    [vin, provider, JSON.stringify(fields), JSON.stringify(raw)],
  );
  return decoded;
}
