"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Deal } from "@bos/core";

/**
 * The deal, laid out the way a desk works through it: the car, the buyer, the money, the trade,
 * the odometer, with the totals updating beside it as figures are typed. Uncontrolled inputs post
 * as an ordinary form; the summary only reads them.
 */

export type PickableVehicle = { id: string; stockNumber: string; name: string; vin: string | null; askingPrice: number | null; mileage: number | null; status: string };
type Values = Partial<Deal> & { stateTaxPct?: number; surtaxPct?: number };

// Spelled out here, not imported, because this runs in the browser. Matches ODOMETER_TEXT in @bos/core.
const ODOMETER: { key: string; label: string }[] = [
  { key: "actual", label: "Actual mileage" },
  { key: "not_actual", label: "Not the actual mileage (warning: odometer discrepancy)" },
  { key: "exceeds", label: "Exceeds its mechanical limits" },
];

/** The same arithmetic as dealMoney in @bos/core, for the live summary. The server's figure is the one saved. */
type Figures = { salePrice: number; dealerFee: number; tradeAllowance: number; stateTaxPct: number; surtaxPct: number; tagTitleFees: number; otherFees: number };
function totals(f: Figures) {
  const cents = (n: number) => Math.round(n * 100) / 100;
  const taxable = Math.max(cents(f.salePrice + f.dealerFee - f.tradeAllowance), 0);
  const stateTax = cents((taxable * f.stateTaxPct) / 100);
  const surtax = cents((Math.min(taxable, 5000) * f.surtaxPct) / 100);
  return { taxable, stateTax, surtax, total: cents(taxable + stateTax + surtax + f.tagTitleFees + f.otherFees) };
}
const num = (v: FormDataEntryValue | null) => {
  const n = Number(String(v ?? "").replace(/[,$]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

export function DealForm({ v, currency, locked, vehicles, chosen, action, submitLabel, paid = 0, children }: {
  v: Values; currency: string; locked: boolean;
  /** Cars that can be sold, for the picker. Omit when the vehicle is fixed. */
  vehicles?: PickableVehicle[];
  chosen?: PickableVehicle | null;
  action: (form: FormData) => void | Promise<void>;
  submitLabel: string;
  paid?: number;
  children?: React.ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [sum, setSum] = useState(() => totals({ salePrice: v.salePrice ?? 0, dealerFee: v.dealerFee ?? 0, tradeAllowance: v.tradeAllowance ?? 0, stateTaxPct: v.stateTaxPct ?? 6, surtaxPct: v.surtaxPct ?? 0, tagTitleFees: v.tagTitleFees ?? 0, otherFees: v.otherFees ?? 0 }));
  const [car, setCar] = useState<PickableVehicle | null>(chosen ?? null);
  const money = (n: number) => `${currency === "USD" ? "$" : `${currency} `}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const d = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

  const recount = () => {
    if (!form.current) return;
    const f = new FormData(form.current);
    setSum(totals({ salePrice: num(f.get("salePrice")), dealerFee: num(f.get("dealerFee")), tradeAllowance: num(f.get("tradeAllowance")), stateTaxPct: num(f.get("stateTaxPct")), surtaxPct: num(f.get("surtaxPct")), tagTitleFees: num(f.get("tagTitleFees")), otherFees: num(f.get("otherFees")) }));
  };
  useEffect(recount, []);

  const pick = (next: PickableVehicle) => {
    setCar(next);
    const f = form.current;
    if (!f) return;
    const price = f.elements.namedItem("salePrice") as HTMLInputElement | null;
    const odo = f.elements.namedItem("odometer") as HTMLInputElement | null;
    if (price && !price.value && next.askingPrice) price.value = String(next.askingPrice);
    if (odo && !odo.value && next.mileage) odo.value = String(next.mileage);
    recount();
  };

  return (
    <form ref={form} action={action} onInput={recount} className="deal-layout">
      <input type="hidden" name="vehicleId" value={car?.id ?? ""} />
      <div className="deal-main">
        <fieldset disabled={locked} className="veh-fieldset stack-panels">
          <section className="glass panel">
            <h2 className="title">Vehicle</h2>
            {vehicles ? <VehiclePicker vehicles={vehicles} chosen={car} onPick={pick} onClear={() => setCar(null)} /> : car ? <VehicleLine car={car} /> : null}
          </section>

          <section className="glass panel">
            <h2 className="title">Buyer</h2>
            <p className="muted">Exactly as on their driver licence; this is what goes on the title.</p>
            <div className="deal-row">
              <label className="field deal-w6"><span>Full name</span><input name="buyerName" required maxLength={200} defaultValue={v.buyerName ?? ""} /></label>
              <label className="field deal-w3"><span>Driver licence no.</span><input name="buyerDl" maxLength={40} defaultValue={v.buyerDl ?? ""} /></label>
              <label className="field deal-w2"><span>Date of birth</span><input name="buyerDob" type="date" defaultValue={v.buyerDob ?? ""} /></label>
              <label className="field deal-w1"><span>Sex</span><select name="buyerSex" defaultValue={v.buyerSex ?? ""}><option value="">—</option><option value="M">M</option><option value="F">F</option><option value="X">X</option></select></label>
            </div>
            <div className="deal-row">
              <label className="field deal-w5"><span>Street address</span><input name="buyerAddress" maxLength={200} defaultValue={v.buyerAddress ?? ""} /></label>
              <label className="field deal-w3"><span>City</span><input name="buyerCity" maxLength={100} defaultValue={v.buyerCity ?? ""} /></label>
              <label className="field deal-w1"><span>State</span><input name="buyerState" maxLength={2} defaultValue={v.buyerState ?? "FL"} /></label>
              <label className="field deal-w2"><span>ZIP</span><input name="buyerZip" maxLength={10} inputMode="numeric" defaultValue={v.buyerZip ?? ""} /></label>
            </div>
            <div className="deal-row">
              <label className="field deal-w2"><span>County</span><input name="buyerCounty" maxLength={60} defaultValue={v.buyerCounty ?? ""} /></label>
              <label className="field deal-w2"><span>Phone</span><input name="buyerPhone" maxLength={40} inputMode="tel" defaultValue={v.buyerPhone ?? ""} /></label>
              <label className="field deal-w3"><span>Email</span><input name="buyerEmail" type="email" maxLength={200} defaultValue={v.buyerEmail ?? ""} /></label>
              <label className="field deal-w3"><span>Co-buyer (optional)</span><input name="coBuyerName" maxLength={200} defaultValue={v.coBuyerName ?? ""} /></label>
            </div>
          </section>

          <section className="glass panel">
            <h2 className="title">Price and fees</h2>
            <div className="deal-row">
              <label className="field deal-w3"><span>Sale price</span><input name="salePrice" inputMode="decimal" required defaultValue={d(v.salePrice)} className="deal-money" /></label>
              <label className="field deal-w2"><span>Dealer fee</span><input name="dealerFee" inputMode="decimal" defaultValue={d(v.dealerFee)} className="deal-money" /></label>
              <label className="field deal-w2"><span>Tag and title</span><input name="tagTitleFees" inputMode="decimal" defaultValue={d(v.tagTitleFees)} className="deal-money" /></label>
              <label className="field deal-w2"><span>Other fees</span><input name="otherFees" inputMode="decimal" defaultValue={d(v.otherFees)} className="deal-money" /></label>
              <label className="field deal-w3"><span>Other fees are for</span><input name="otherFeesNote" maxLength={200} defaultValue={v.otherFeesNote ?? ""} /></label>
            </div>
            <div className="deal-row">
              <label className="field deal-w2"><span>State sales tax %</span><input name="stateTaxPct" inputMode="decimal" defaultValue={d(v.stateTaxPct)} /></label>
              <label className="field deal-w2"><span>County surtax %</span><input name="surtaxPct" inputMode="decimal" defaultValue={d(v.surtaxPct)} /></label>
              <p className="muted deal-hint">Florida taxes the price plus dealer fee, less any trade-in. The county surtax applies to the first $5,000 of that.</p>
            </div>
          </section>

          <section className="glass panel">
            <h2 className="title">Trade-in <span className="muted">(optional)</span></h2>
            <div className="deal-row">
              <label className="field deal-w3"><span>VIN</span><input name="tradeVin" maxLength={20} className="mono" defaultValue={v.tradeVin ?? ""} /></label>
              <label className="field deal-w4"><span>What it is</span><input name="tradeDescription" maxLength={200} placeholder="2017 Tesla Model S, white" defaultValue={v.tradeDescription ?? ""} /></label>
              <label className="field deal-w2"><span>Mileage</span><input name="tradeMileage" inputMode="numeric" defaultValue={d(v.tradeMileage)} /></label>
              <label className="field deal-w2"><span>Allowance</span><input name="tradeAllowance" inputMode="decimal" defaultValue={d(v.tradeAllowance)} className="deal-money" /></label>
            </div>
            <p className="muted footnote">When the deal is delivered the trade-in joins the lot as a draft, at the allowance.</p>
          </section>

          <section className="glass panel">
            <h2 className="title">At delivery</h2>
            <div className="deal-row">
              <label className="field deal-w2"><span>Odometer reading</span><input name="odometer" inputMode="numeric" defaultValue={d(v.odometer)} /></label>
              <label className="field deal-w4"><span>Odometer statement</span><select name="odometerBrand" defaultValue={v.odometerBrand ?? "actual"}>{ODOMETER.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select></label>
              <label className="field deal-w3"><span>Warranty</span><select name="soldAsIs" defaultValue={v.soldAsIs === false ? "no" : "yes"}><option value="yes">Sold as is, no dealer warranty</option><option value="no">Dealer warranty</option></select></label>
              <label className="field deal-w3"><span>Warranty terms</span><input name="warrantyNote" maxLength={500} defaultValue={v.warrantyNote ?? ""} /></label>
            </div>
            <label className="field"><span>Notes</span><textarea name="notes" rows={2} maxLength={4000} defaultValue={v.notes ?? ""} /></label>
          </section>
        </fieldset>
        {children}
      </div>

      <aside className="deal-side">
        <div className="glass panel deal-summary">
          <h2 className="title">Total</h2>
          <div className="deal-sum">
            <div><span>Taxable amount</span><span>{money(sum.taxable)}</span></div>
            <div><span>Sales tax</span><span>{money(sum.stateTax)}</span></div>
            {sum.surtax > 0 && <div><span>County surtax</span><span>{money(sum.surtax)}</span></div>}
            <div className="deal-total"><span>Total</span><span>{money(sum.total)}</span></div>
            {paid > 0 && <div><span>Paid</span><span>−{money(paid)}</span></div>}
            {paid > 0 && <div className="deal-total"><span>Balance</span><span>{money(Math.max(sum.total - paid, 0))}</span></div>}
          </div>
          {!locked && (
            <div className="actions deal-actions">
              <button type="submit" className="btn btn-primary" disabled={!car}>{submitLabel}</button>
              <Link href="/deals" className="btn btn-glass">Cancel</Link>
            </div>
          )}
          {!locked && !car && <p className="muted">Pick the car first.</p>}
        </div>
      </aside>
    </form>
  );
}

function VehicleLine({ car }: { car: PickableVehicle }) {
  return (
    <div className="deal-car">
      <div>
        <div className="deal-car-name">{car.name || "Details to come"}</div>
        <div className="muted"><span className="mono">{car.stockNumber}</span>{car.vin ? <> · <span className="mono">{car.vin}</span></> : null}{car.mileage ? ` · ${car.mileage.toLocaleString("en-US")} mi` : ""}</div>
      </div>
      <Link href={`/vehicles/${car.id}`} className="row-link">Open</Link>
    </div>
  );
}

/** Type a stock number, VIN, make or model; pick from what matches. */
function VehiclePicker({ vehicles, chosen, onPick, onClear }: { vehicles: PickableVehicle[]; chosen: PickableVehicle | null; onPick: (v: PickableVehicle) => void; onClear: () => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (v: PickableVehicle) => `${v.stockNumber} ${v.name} ${v.vin ?? ""}`.toLowerCase();
    return (words.length ? vehicles.filter((v) => words.every((w) => hay(v).includes(w))) : vehicles).slice(0, 8);
  }, [q, vehicles]);
  if (chosen) {
    return (
      <div className="deal-car-row">
        <VehicleLine car={chosen} />
        <button type="button" className="btn btn-glass btn-small" onClick={() => { setQ(""); setOpen(true); onClear(); setTimeout(() => box.current?.focus(), 0); }}>Change</button>
      </div>
    );
  }
  return (
    <div className="deal-picker">
      <label className="field">
        <span>Which car</span>
        <input
          ref={box} value={q} placeholder="Type a stock number, VIN, make or model" autoComplete="off" role="combobox" aria-expanded={open} aria-controls="veh-matches"
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, matches.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter" && open && matches[active]) { e.preventDefault(); onPick(matches[active]!); setOpen(false); }
            else if (e.key === "Escape") setOpen(false);
          }}
        />
      </label>
      {open && (
        <ul id="veh-matches" className="deal-matches" role="listbox">
          {matches.length === 0 && <li className="muted deal-nomatch">Nothing on the lot matches that.</li>}
          {matches.map((m, i) => (
            <li key={m.id} role="option" aria-selected={i === active} className={i === active ? "is-active" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick(m); setOpen(false); }}>
              <span className="mono deal-m-stock">{m.stockNumber}</span>
              <span className="deal-m-name">{m.name || "Details to come"}</span>
              <span className="muted deal-m-meta">{m.vin ? `${m.vin} · ` : ""}{m.mileage ? `${m.mileage.toLocaleString("en-US")} mi · ` : ""}{m.askingPrice ? `asking ${m.askingPrice.toLocaleString("en-US")}` : "no asking price"}{m.status === "recon" ? " · in recon" : m.status === "draft" ? " · draft" : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
