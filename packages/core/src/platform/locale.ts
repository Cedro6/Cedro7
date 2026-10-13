import type { Ctx } from "./context";

/** Where a company keeps its clock and which currency its figures are in. One of each per company; nothing is converted. */
export const DEFAULT_TIME_ZONE = "America/New_York";
export const DEFAULT_CURRENCY = "USD";

export const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "NZD", "MXN", "CHF", "SEK", "NOK", "DKK", "JPY", "INR", "SGD", "HKD", "ZAR", "BRL", "AED"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const isCurrency = (v: unknown): v is Currency => (CURRENCIES as readonly unknown[]).includes(v);

const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

/** True for a time zone name this computer knows, such as "Europe/London". */
export function isTimeZone(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 64 || !ZONE_SHAPE.test(v)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

/** Every time zone that can be chosen, for the settings list. */
export function timeZones(): string[] {
  const all = Intl.supportedValuesOf("timeZone");
  return all.includes("UTC") ? all : ["UTC", ...all];
}

/**
 * The company's time zone. The name is checked for shape before it is used, because queries place
 * it in their text; anything unexpected falls back to the default.
 */
export function zoneOf(ctx: Pick<Ctx, "timeZone">): string {
  return ctx.timeZone && ZONE_SHAPE.test(ctx.timeZone) && ctx.timeZone.length <= 64 ? ctx.timeZone : DEFAULT_TIME_ZONE;
}

export function currencyOf(ctx: Pick<Ctx, "currency">): Currency {
  return isCurrency(ctx.currency) ? ctx.currency : DEFAULT_CURRENCY;
}

/** Money as text in the company's currency. `whole` drops the cents. */
export function moneyText(amount: number, currency: string = DEFAULT_CURRENCY, whole = false): string {
  const code = isCurrency(currency) ? currency : DEFAULT_CURRENCY;
  return amount.toLocaleString("en-US", { style: "currency", currency: code, ...(whole ? { maximumFractionDigits: 0 } : {}) });
}

/** Today's date, YYYY-MM-DD, in a time zone. */
export function todayIn(zone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
