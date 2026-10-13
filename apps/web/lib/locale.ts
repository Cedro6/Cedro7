import { cache } from "react";
import { DEFAULT_CURRENCY, DEFAULT_TIME_ZONE, moneyText, todayIn } from "@bos/core";

/**
 * The signed-in company's time zone and currency for the request being served.
 * `requireSession` fills it in; everything that prints a date or an amount reads it.
 */
const store = cache(() => ({ zone: DEFAULT_TIME_ZONE, currency: DEFAULT_CURRENCY as string }));

export function setLocale(zone: string | undefined, currency: string | undefined): void {
  const s = store();
  s.zone = zone ?? DEFAULT_TIME_ZONE;
  s.currency = currency ?? DEFAULT_CURRENCY;
}

export const zone = (): string => store().zone;
export const currency = (): string => store().currency;
/** Today's date, YYYY-MM-DD, on the company's clock. */
export const todayHere = (): string => todayIn(zone());
/** An amount with no cents, such as "$1,235". */
export const whole = (n: number): string => moneyText(n, currency(), true);
/** The currency's symbol, such as "$" or "£". */
export const symbol = (): string => moneyText(0, currency(), true).replace(/[\d.,\s]/g, "") || "$";
