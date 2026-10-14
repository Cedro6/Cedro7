import type { CompanyProfile, DealerSettings } from "@bos/core";

/**
 * The FTC Buyers Guide, as the Used Car Rule lays it out: the warranty choice up front, the
 * vehicle, and the dealer. The same sheet prints from a car on the lot (for the window) and from
 * a deal (to hand to the buyer and have them sign).
 */
export function BuyersGuideSheet({ car, soldAsIs, warrantyNote, company, dealer, signature = true }: {
  car: { make: string | null | undefined; model: string | null | undefined; year: number | null | undefined; vin: string | null; stockNumber: string };
  soldAsIs: boolean; warrantyNote: string | null; company: CompanyProfile; dealer: DealerSettings;
  /** The buyer's acknowledgement at closing. Shown on a deal's copy. */
  signature?: boolean;
}) {
  return (
        <section className="paper guide">
          <h2 className="guide-title">BUYERS GUIDE</h2>
          <p className="guide-strong">IMPORTANT: Spoken promises are difficult to enforce. Ask the dealer to put all promises in writing. Keep this form.</p>
          <table className="guide-table">
            <tbody>
              <tr><th>VEHICLE MAKE</th><td>{car.make ?? ""}</td><th>MODEL</th><td>{car.model ?? ""}</td><th>YEAR</th><td>{car.year ?? ""}</td></tr>
              <tr><th>VIN</th><td colSpan={3} className="mono">{car.vin ?? ""}</td><th>STOCK NO.</th><td>{car.stockNumber}</td></tr>
            </tbody>
          </table>
          <h3 className="guide-h">WARRANTIES FOR THIS VEHICLE:</h3>
          <div className={`guide-box ${soldAsIs ? "guide-chosen" : ""}`}>
            <div className="guide-check">{soldAsIs ? "☒" : "☐"} <strong>AS IS – NO DEALER WARRANTY</strong></div>
            <p>THE DEALER DOES NOT PROVIDE A WARRANTY FOR ANY REPAIRS AFTER SALE.</p>
          </div>
          <div className={`guide-box ${!soldAsIs ? "guide-chosen" : ""}`}>
            <div className="guide-check">{!soldAsIs ? "☒" : "☐"} <strong>DEALER WARRANTY</strong></div>
            <p>{!soldAsIs && warrantyNote ? warrantyNote : "☐ FULL WARRANTY   ☐ LIMITED WARRANTY. The dealer will pay ____% of the labor and ____% of the parts for the covered systems that fail during the warranty period. Ask the dealer for a copy of the warranty document for a full explanation of warranty coverage, exclusions, and the dealer's repair obligations."}</p>
          </div>
          <p><strong>NON-DEALER WARRANTIES FOR THIS VEHICLE:</strong> ☐ MANUFACTURER&apos;S WARRANTY STILL APPLIES ☐ MANUFACTURER&apos;S USED VEHICLE WARRANTY APPLIES ☐ OTHER USED VEHICLE WARRANTY APPLIES. Ask the dealer for a copy of the warranty document and an explanation of warranty coverage, exclusions, and repair obligations.</p>
          <p><strong>SERVICE CONTRACT.</strong> ☐ A service contract on this vehicle is available for an extra charge. Ask for details about coverage, deductible, price, and exclusions.</p>
          <p><strong>ASK THE DEALER IF YOUR MECHANIC CAN INSPECT THE VEHICLE ON OR OFF THE LOT.</strong></p>
          <p><strong>OBTAIN A VEHICLE HISTORY REPORT AND CHECK FOR OPEN SAFETY RECALLS.</strong> For information on how to obtain a vehicle history report, visit ftc.gov/usedcars. To check for open safety recalls, visit safercar.gov. You will need the VIN shown above to make the best use of the resources on these sites.</p>
          <p className="guide-muted">SEE THE BACK OF THIS FORM for important additional information, including a list of some major defects that may occur in used motor vehicles.</p>
          <div className="guide-dealer">
            <div><strong>DEALER</strong><div>{company.name}</div></div>
            <div><strong>ADDRESS</strong><div>{(company.address ?? "").replace(/\n/g, ", ")}</div></div>
            <div><strong>SEE FOR COMPLAINTS</strong><div>{company.phone ?? ""} {company.email ?? ""}</div></div>
            {dealer.licence && <div><strong>LICENSE</strong><div>{dealer.licence}</div></div>}
          </div>
          {signature && <p className="guide-muted">I hereby acknowledge receipt of the Buyers Guide at the closing of this sale.</p>}
          {signature && <div className="paper-sign"><div><div className="sign-line" /><div className="paper-label">Buyer</div></div><div><div className="sign-line" /><div className="paper-label">Date</div></div></div>}
        </section>
  );
}
