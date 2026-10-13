import type { Deal } from "@bos/core";

// Spelled out here (not imported) because this file is shared with browser components. Matches ODOMETER_TEXT in @bos/core.
const ODOMETER: { key: string; label: string }[] = [
  { key: "actual", label: "Actual mileage" },
  { key: "not_actual", label: "Not the actual mileage (warning: odometer discrepancy)" },
  { key: "exceeds", label: "Exceeds its mechanical limits" },
];

type Values = Partial<Deal> & { stateTaxPct?: number; surtaxPct?: number };

/** Everything on the deal, in the order the paperwork asks for it. */
export function DealFields({ v, currency, locked }: { v: Values; currency: string; locked: boolean }) {
  const d = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));
  return (
    <fieldset disabled={locked} className="veh-fieldset stack-panels">
      <section className="glass panel">
        <h2 className="title">Buyer</h2>
        <p className="muted">Exactly as it should appear on the title. The address is required before delivery.</p>
        <div className="veh-grid">
          <label className="field"><span>Full name</span><input name="buyerName" required maxLength={200} defaultValue={v.buyerName ?? ""} /></label>
          <label className="field"><span>Co-buyer (optional)</span><input name="coBuyerName" maxLength={200} defaultValue={v.coBuyerName ?? ""} /></label>
          <label className="field"><span>Driver licence no.</span><input name="buyerDl" maxLength={40} defaultValue={v.buyerDl ?? ""} /></label>
          <label className="field"><span>Date of birth</span><input name="buyerDob" type="date" defaultValue={v.buyerDob ?? ""} /></label>
          <label className="field"><span>Sex (as on licence)</span><select name="buyerSex" defaultValue={v.buyerSex ?? ""}><option value="">—</option><option value="M">M</option><option value="F">F</option><option value="X">X</option></select></label>
          <label className="field"><span>County of residence</span><input name="buyerCounty" maxLength={60} defaultValue={v.buyerCounty ?? ""} /></label>
          <label className="field"><span>Street address</span><input name="buyerAddress" maxLength={200} defaultValue={v.buyerAddress ?? ""} /></label>
          <label className="field"><span>City</span><input name="buyerCity" maxLength={100} defaultValue={v.buyerCity ?? ""} /></label>
          <label className="field"><span>State</span><input name="buyerState" maxLength={2} defaultValue={v.buyerState ?? "FL"} /></label>
          <label className="field"><span>ZIP</span><input name="buyerZip" maxLength={10} defaultValue={v.buyerZip ?? ""} /></label>
          <label className="field"><span>Phone</span><input name="buyerPhone" maxLength={40} defaultValue={v.buyerPhone ?? ""} /></label>
          <label className="field"><span>Email</span><input name="buyerEmail" type="email" maxLength={200} defaultValue={v.buyerEmail ?? ""} /></label>
        </div>
      </section>
      <section className="glass panel">
        <h2 className="title">Price and fees ({currency})</h2>
        <div className="veh-grid">
          <label className="field"><span>Sale price</span><input name="salePrice" inputMode="decimal" required defaultValue={d(v.salePrice)} /></label>
          <label className="field"><span>Dealer fee</span><input name="dealerFee" inputMode="decimal" defaultValue={d(v.dealerFee)} /></label>
          <label className="field"><span>Tag, title and registration</span><input name="tagTitleFees" inputMode="decimal" defaultValue={d(v.tagTitleFees)} /></label>
          <label className="field"><span>Other fees</span><input name="otherFees" inputMode="decimal" defaultValue={d(v.otherFees)} /></label>
          <label className="field"><span>Other fees are for</span><input name="otherFeesNote" maxLength={200} defaultValue={v.otherFeesNote ?? ""} /></label>
          <label className="field"><span>State sales tax %</span><input name="stateTaxPct" inputMode="decimal" defaultValue={d(v.stateTaxPct)} /></label>
          <label className="field"><span>County surtax %</span><input name="surtaxPct" inputMode="decimal" defaultValue={d(v.surtaxPct)} /></label>
        </div>
        <p className="muted footnote">Florida taxes the price plus dealer fee, less any trade-in. The county surtax applies to the first $5,000 of that.</p>
      </section>
      <section className="glass panel">
        <h2 className="title">Trade-in (optional)</h2>
        <div className="veh-grid">
          <label className="field"><span>Trade-in VIN</span><input name="tradeVin" maxLength={20} className="mono" defaultValue={v.tradeVin ?? ""} /></label>
          <label className="field"><span>Describe it</span><input name="tradeDescription" maxLength={200} placeholder="2017 Tesla Model S, white" defaultValue={v.tradeDescription ?? ""} /></label>
          <label className="field"><span>Trade-in mileage</span><input name="tradeMileage" inputMode="numeric" defaultValue={d(v.tradeMileage)} /></label>
          <label className="field"><span>Allowance ({currency})</span><input name="tradeAllowance" inputMode="decimal" defaultValue={d(v.tradeAllowance)} /></label>
        </div>
        <p className="muted footnote">When the deal is delivered, the trade-in is added to the lot as a draft at the allowance.</p>
      </section>
      <section className="glass panel">
        <h2 className="title">The car at sale</h2>
        <div className="veh-grid">
          <label className="field"><span>Odometer reading</span><input name="odometer" inputMode="numeric" defaultValue={d(v.odometer)} /></label>
          <label className="field">
            <span>Odometer statement</span>
            <select name="odometerBrand" defaultValue={v.odometerBrand ?? "actual"}>{ODOMETER.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</select>
          </label>
          <label className="field">
            <span>Warranty</span>
            <select name="soldAsIs" defaultValue={v.soldAsIs === false ? "no" : "yes"}><option value="yes">Sold as is, no dealer warranty</option><option value="no">Dealer warranty (describe below)</option></select>
          </label>
          <label className="field"><span>Warranty terms</span><input name="warrantyNote" maxLength={500} defaultValue={v.warrantyNote ?? ""} /></label>
        </div>
        <label className="field"><span>Notes</span><textarea name="notes" rows={2} maxLength={4000} defaultValue={v.notes ?? ""} /></label>
      </section>
    </fieldset>
  );
}
