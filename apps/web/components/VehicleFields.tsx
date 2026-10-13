import type { VehicleOwnInput, VehicleSpecs, VehicleStatus } from "@bos/core";

// Spelled out here rather than imported: this file is used by a browser component, which must not pull in the server code.
// They match VEHICLE_STATUSES, VEHICLE_STATUS_TEXT and VEHICLE_CONDITIONS in @bos/core.
const STATUSES: { key: VehicleStatus; label: string }[] = [
  { key: "draft", label: "Draft" }, { key: "recon", label: "In reconditioning" }, { key: "on_lot", label: "On the lot" }, { key: "sold", label: "Sold" }, { key: "removed", label: "Removed" },
];
const CONDITIONS = ["Excellent", "Good", "Fair", "Poor", "Salvage"];

export const SPEC_LABEL: Record<keyof VehicleSpecs, string> = {
  year: "Year", make: "Make", model: "Model", trim: "Trim", bodyStyle: "Body style", engine: "Engine", displacementL: "Displacement (L)", cylinders: "Cylinders",
  horsepower: "Horsepower", transmission: "Transmission", drivetrain: "Drivetrain", fuelType: "Fuel", category: "Category", manufacturer: "Manufacturer",
  doors: "Doors", cab: "Cab", bedLength: "Bed length", madeIn: "Made in",
};
const NUMERIC: (keyof VehicleSpecs)[] = ["year", "displacementL", "cylinders", "horsepower", "doors"];
const ORDER: (keyof VehicleSpecs)[] = ["year", "make", "model", "trim", "bodyStyle", "category", "engine", "displacementL", "cylinders", "horsepower", "transmission", "drivetrain", "fuelType", "doors", "cab", "bedLength", "manufacturer", "madeIn"];

/**
 * The specification fields, one input each. On the review screen a field the decoder filled is
 * marked as such, one it could not fill is flagged so the dealer knows to check it.
 */
export function SpecFields({ values, provenance, missing }: { values: Partial<VehicleSpecs>; provenance?: Record<string, string>; missing?: (keyof VehicleSpecs)[] }) {
  return (
    <div className="veh-grid">
      {ORDER.map((field) => {
        const value = values[field];
        const from = provenance?.[field];
        const flagged = missing?.includes(field);
        return (
          <label className={`field ${flagged ? "veh-missing" : ""}`} key={field}>
            <span>
              {SPEC_LABEL[field]}
              {from === "decoder" && <em className="veh-from" title="Filled from the VIN">VIN</em>}
              {from === "manual" && <em className="veh-from veh-from-manual" title="Typed by hand">typed</em>}
              {flagged && <em className="veh-from veh-from-missing" title="The VIN did not say">not from VIN</em>}
            </span>
            <input
              name={field} defaultValue={value === undefined || value === null ? "" : String(value)} maxLength={120}
              inputMode={NUMERIC.includes(field) ? "decimal" : undefined} placeholder={flagged ? "Unknown" : ""}
            />
          </label>
        );
      })}
    </div>
  );
}

/** What only the dealer knows about this particular car. */
export function OwnFields({ values, showCost, currency }: { values: Partial<VehicleOwnInput>; showCost: boolean; currency: string }) {
  return (
    <>
      <div className="veh-grid">
        <label className="field"><span>Mileage</span><input name="mileage" inputMode="numeric" defaultValue={values.mileage ?? ""} /></label>
        <label className="field"><span>Colour</span><input name="colour" maxLength={40} defaultValue={values.colour ?? ""} /></label>
        <label className="field">
          <span>Condition</span>
          <select name="condition" defaultValue={values.condition ?? ""}>
            <option value="">Not graded</option>
            {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Status</span>
          <select name="status" defaultValue={values.status ?? "draft"}>
            {STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        {showCost && <label className="field"><span>Paid for it ({currency})</span><input name="acquisitionPrice" inputMode="decimal" defaultValue={values.acquisitionPrice ?? ""} /></label>}
        {showCost && <label className="field"><span>Bought from</span><input name="acquisitionSource" maxLength={120} placeholder="Auction, trade-in, private seller…" defaultValue={values.acquisitionSource ?? ""} /></label>}
        {showCost && <label className="field"><span>Bought on</span><input name="acquiredOn" type="date" defaultValue={values.acquiredOn ?? ""} /></label>}
        <label className="field"><span>Asking price ({currency})</span><input name="askingPrice" inputMode="decimal" defaultValue={values.askingPrice ?? ""} /></label>
      </div>
      <div className="veh-grid">
        <label className="field"><span>Title number</span><input name="titleNumber" maxLength={40} defaultValue={values.titleNumber ?? ""} /></label>
        <label className="field"><span>Title state</span><input name="titleState" maxLength={2} defaultValue={values.titleState ?? "FL"} /></label>
        <label className="field"><span>Title issued on</span><input name="titleIssuedOn" type="date" defaultValue={values.titleIssuedOn ?? ""} /></label>
      </div>
      <label className="field"><span>Notes for the team</span><textarea name="notes" rows={2} maxLength={4000} defaultValue={values.notes ?? ""} /></label>
    </>
  );
}
