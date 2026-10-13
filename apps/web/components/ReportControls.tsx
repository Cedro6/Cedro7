"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Option = { value: string; label: string };

/** Period and comparison pickers for the report. Choosing one reloads the report straight away; custom dates wait for Apply. */
export function ReportControls({ period, compare, from, to, tab, periods, compares }: {
  period: string; compare: string; from: string; to: string; tab: string; periods: Option[]; compares: Option[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [custom, setCustom] = useState(period === "custom");
  const [dates, setDates] = useState({ from, to });
  const backwards = dates.from > dates.to;

  const go = (next: { period: string; compare: string; from?: string; to?: string }) => {
    const p = new URLSearchParams();
    if (next.period !== "30d") p.set("period", next.period);
    if (next.period === "custom") {
      p.set("from", next.from ?? dates.from);
      p.set("to", next.to ?? dates.to);
    }
    if (next.compare !== "previous") p.set("compare", next.compare);
    if (tab !== "overview") p.set("tab", tab);
    const s = p.toString();
    start(() => router.push(s ? `/reports?${s}` : "/reports", { scroll: false }));
  };

  return (
    <div className="rpt-controls" aria-busy={pending}>
      <label className="field">
        Period
        <select
          value={custom ? "custom" : period}
          onChange={(e) => {
            const value = e.target.value;
            setCustom(value === "custom");
            if (value !== "custom") go({ period: value, compare });
          }}
        >
          {periods.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {custom && (
        <>
          <label className="field">
            From
            <input type="date" value={dates.from} max={dates.to} onChange={(e) => setDates({ ...dates, from: e.target.value })} />
          </label>
          <label className="field">
            To
            <input type="date" value={dates.to} min={dates.from} onChange={(e) => setDates({ ...dates, to: e.target.value })} />
          </label>
          <button type="button" className="btn btn-primary btn-small" disabled={backwards || !dates.from || !dates.to || pending} onClick={() => go({ period: "custom", compare })}>
            Apply
          </button>
        </>
      )}
      <label className="field">
        Compare with
        <select value={compare} onChange={(e) => go({ period: custom ? "custom" : period, compare: e.target.value })}>
          {compares.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {custom && backwards && <p className="error rpt-wide" role="alert">The start date must be on or before the end date.</p>}
    </div>
  );
}
