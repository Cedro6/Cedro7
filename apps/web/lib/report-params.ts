import { compareRange, isAnalysisPreset, isCompareMode, resolveRange, type AnalysisPreset, type CompareMode, type DateRange } from "@bos/core";
import { todayHere } from "./locale";

export const REPORT_TABS = ["overview", "products", "customers", "money", "profit", "stock", "purchasing"] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

export const PRESET_LABEL: Record<AnalysisPreset, string> = {
  this_month: "This month",
  last_month: "Last month",
  this_quarter: "This quarter",
  last_quarter: "Last quarter",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  ytd: "Year to date",
  "12m": "Last 12 months",
  last_year: "Last year",
  custom: "Custom dates",
};
export const COMPARE_LABEL: Record<CompareMode, string> = {
  previous: "The period before",
  year: "Same dates last year",
  none: "Nothing",
};

export type ReportQuery = { period?: string; from?: string; to?: string; compare?: string; tab?: string };
export type ReportView = { preset: AnalysisPreset; mode: CompareMode; range: DateRange; compare: DateRange | null; tab: ReportTab };

export function readReportQuery(q: ReportQuery): ReportView {
  const preset = isAnalysisPreset(q.period) ? q.period : "30d";
  const mode = isCompareMode(q.compare) ? q.compare : "previous";
  const range = resolveRange(preset, todayHere(), { from: q.from, to: q.to });
  const tab = (REPORT_TABS as readonly string[]).includes(q.tab ?? "") ? (q.tab as ReportTab) : "overview";
  return { preset, mode, range, compare: compareRange(range, mode), tab };
}

/** The address for a view of the report. Defaults are left out so the plain address stays short. */
export function reportHref(view: Pick<ReportView, "preset" | "mode" | "range" | "tab">, change: Partial<Pick<ReportView, "tab">> = {}, path = "/reports", extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (view.preset !== "30d") p.set("period", view.preset);
  if (view.preset === "custom") {
    p.set("from", view.range.from);
    p.set("to", view.range.to);
  }
  if (view.mode !== "previous") p.set("compare", view.mode);
  const tab = change.tab ?? view.tab;
  if (tab !== "overview" && path === "/reports") p.set("tab", tab);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

const day = (iso: string, year: boolean) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: year ? "numeric" : undefined, timeZone: "UTC" });
/** "Sep 13 to Oct 12, 2026", with the first year shown only when the two differ. */
export const rangeText = (r: DateRange) => `${day(r.from, r.from.slice(0, 4) !== r.to.slice(0, 4))} to ${day(r.to, true)}`;
