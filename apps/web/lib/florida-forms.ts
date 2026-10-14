import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, type PDFForm } from "pdf-lib";
import type { CompanyProfile, Deal, DealerSettings } from "@bos/core";

/**
 * Florida's own title forms, filled from the deal. The PDFs are the state's current versions, kept in
 * apps/web/forms/florida; the fields are set by name, so a new revision of a form needs its names
 * checked again. Signatures are never filled: the people sign the printed page.
 */
export const FLORIDA_FORMS = {
  "82040": { title: "Application for Certificate of Title (HSMV 82040)", about: "The buyer's application for the Florida title. Sections 1, 2, 5, 6, 7 and 12 are filled; the buyer signs section 12." },
  "82050": { title: "Notice of Sale / Bill of Sale (HSMV 82050)", about: "Filled as a bill of sale with the odometer statement. Seller and buyer sign section 3." },
  "82993": { title: "Odometer Disclosure Statement (HSMV 82993)", about: "The federal odometer statement, seller to buyer. Both sign." },
  "82053": { title: "Power of Attorney (HSMV 82053)", about: "Lets the dealership apply for the title on the buyer's behalf. The buyer signs." },
} as const;
export type FloridaForm = keyof typeof FLORIDA_FORMS;
export const isFloridaForm = (v: string): v is FloridaForm => v in FLORIDA_FORMS;

type Source = { deal: Deal; company: CompanyProfile; dealer: DealerSettings; today: string };

const mdy = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : "");
const parts = (iso: string) => ({ mm: iso.slice(5, 7), dd: iso.slice(8, 10), yyyy: iso.slice(0, 4) });
const money = (n: number) => n.toFixed(2);
/** Six odometer digits, most significant first, blank-padded on the left. */
const digits = (n: number | null) => (n === null ? ["", "", "", "", "", ""] : String(Math.min(n, 999999)).padStart(6, " ").split("").map((c) => c.trim()));
const addressLine = (p: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null }) => [p.address, [p.city, p.state, p.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
/** The dealership's address as street, city, state and ZIP, from "500 Harbor Way\nTampa, FL 33602" or the same on one line. */
function companyParts(c: CompanyProfile) {
  const lines = (c.address ?? "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  const m = last.match(/^(.*?),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (lines.length === 1 && !m) {
    const one = last.match(/^(.*?),\s*(.*?),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
    if (one) return { street: one[1]!, city: one[2]!, state: one[3]!, zip: one[4]! };
  }
  return m ? { street: lines.slice(0, -1).join(", "), city: m[1]!, state: m[2]!, zip: m[3]! } : { street: lines[0] ?? "", city: lines.slice(1).join(" "), state: "FL", zip: "" };
}

function setText(form: PDFForm, name: string, value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return;
  try {
    form.getTextField(name).setText(String(value));
  } catch (error) {
    throw new Error(`Form field "${name}" is missing or not a text field.`, { cause: error });
  }
}
function tick(form: PDFForm, name: string, on = true) {
  if (!on) return;
  try {
    form.getCheckBox(name).check();
  } catch (error) {
    throw new Error(`Form field "${name}" is missing or not a check box.`, { cause: error });
  }
}

const fillers: Record<FloridaForm, (form: PDFForm, s: Source) => void> = {
  "82040": (f, { deal: d, company, dealer, today }) => {
    tick(f, "Transfer");
    tick(f, "No"); // the dealer does not need the title printed in the office
    if ((d.buyerState ?? "FL") === "FL") {
      try { f.getRadioGroup("Are you a Florida Resident").select("YES"); } catch { /* the group may be named differently on a newer form; the buyer can tick it */ }
    }
    setText(f, "Owner s County of Residence", d.buyerCounty ?? dealer.county);
    setText(f, "Owner’s Name as It Appears on Driver License (First, Full Middle/Maiden, & Last Name)", d.buyerName);
    setText(f, "Owner’s Phone Number (Voluntary)", d.buyerPhone);
    setText(f, "Owners Email Voluntary", d.buyerEmail);
    setText(f, "Owner's Sex", d.buyerSex);
    setText(f, "Owner's Date of Birth", mdy(d.buyerDob));
    setText(f, "Owner's FL DL/ID or FEID/Suffix Number", d.buyerDl);
    setText(f, "Owners Mailing Address", d.buyerAddress);
    setText(f, "Owner's City", d.buyerCity);
    setText(f, "Owner's State", d.buyerState);
    setText(f, "Owner's Zip Code", d.buyerZip);
    setText(f, "Owner's Residential Street Address", d.buyerAddress);
    setText(f, "Owner’s Residential City", d.buyerCity);
    setText(f, "Owner’s Residential State", d.buyerState);
    setText(f, "Owner’s Residential Zip Code", d.buyerZip);
    if (d.coBuyerName) {
      tick(f, "Joint Ownership: AND");
      setText(f, "Co-Owner or Lessee’s Name as It Appears on Driver License (First, Full Middle/Maiden, & Last Name)", d.coBuyerName);
    }
    setText(f, "Vehicle Identification Number VIN", d.vin);
    setText(f, "Florida Title Number", d.titleState === "FL" ? d.titleNumber : null);
    setText(f, "Previous State of Issue", d.titleState && d.titleState !== "FL" ? d.titleState : null);
    setText(f, "Make/Manufacturer", d.vehicleMake);
    setText(f, "Model", d.vehicleModel);
    setText(f, "Year", d.vehicleYear);
    setText(f, "Body", d.vehicleBody);
    setText(f, "Color", d.vehicleColour);
    // Section 5: transfer by sale, with the price and the date acquired.
    tick(f, "Sale");
    const price = d.salePrice;
    setText(f, "Sale Price in US Dollars", String(Math.floor(price)));
    setText(f, "Sale Price in Cents", String(Math.round((price - Math.floor(price)) * 100)).padStart(2, "0"));
    const acquired = parts(d.deliveredOn ?? today);
    setText(f, "Date Acquired MM", acquired.mm);
    setText(f, "Date Aquired DD", acquired.dd);
    setText(f, "Date Aquired YYYY", acquired.yyyy);
    // Section 6: odometer.
    tick(f, "6-digit odometer now reads");
    const [a, b, c, e, g, h] = digits(d.odometer);
    setText(f, "100, 000 Place", a);
    setText(f, "10,000 Place", b);
    setText(f, "1,000 Place", c);
    setText(f, "100 Place", e);
    setText(f, "10 Place", g);
    setText(f, "Ones Place", h);
    const read = parts(d.deliveredOn ?? today);
    setText(f, "Date Read MM", read.mm);
    setText(f, "Date Read DD", read.dd);
    setText(f, "Date Read YYYY", read.yyyy);
    tick(f, "1  REFLECTS ACTUAL MILEAGE", d.odometerBrand === "actual");
    tick(f, "2 IS NOT THE ACTUAL MILEAGE", d.odometerBrand === "not_actual");
    tick(f, "3 IS IN EXCESS OF ITS MECHANICAL LIMITS", d.odometerBrand === "exceeds");
    // Section 7: dealer sales tax report and trade-in.
    setText(f, "Florida Sales Tax Registration Number", company.taxNumber);
    setText(f, "Dealer License Number", dealer.licence);
    setText(f, "Date of Sale", mdy(d.deliveredOn ?? today));
    setText(f, "Amount of Tax", money(d.stateTax + d.surtax));
    if (d.tradeVin) {
      const words = (d.tradeDescription ?? "").split(/\s+/);
      setText(f, "Year of Trade In", /^\d{4}$/.test(words[0] ?? "") ? words[0] : null);
      setText(f, "Make of Trade In", /^\d{4}$/.test(words[0] ?? "") ? words.slice(1).join(" ") : d.tradeDescription);
      setText(f, "Vehicle Identification Number VIN of Trade In", d.tradeVin);
    }
    // Section 8: the dealer verifies the VIN.
    setText(f, "Vehicle Identification Number VIN_2", d.vin);
    tick(f, "Florida Dealer");
    setText(f, "Dealer Name", company.name);
    setText(f, "Dealer Number", dealer.licence);
    // Section 12: the applicant's printed name; they sign beside it.
    setText(f, "Full Name of Applicant Owner", d.buyerName);
    setText(f, "Full Name of Applicant CoOwner", d.coBuyerName);
  },
  "82050": (f, { deal: d, company, today }) => {
    tick(f, "Bill of Sale Seller and purchaser must complete sections 1 2 when applicable  3");
    setText(f, "Year", d.vehicleYear);
    setText(f, "MakeManufacturer", d.vehicleMake);
    setText(f, "Body Type", d.vehicleBody);
    setText(f, "Model", d.vehicleModel);
    setText(f, "Color", d.vehicleColour);
    setText(f, "Iwe do hereby sell or have sold and delivered the above described motor vehicle mobile home", d.titleNumber); // certificate of title number
    setText(f, "VehicleVessel Identification Number", d.vin);
    setText(f, "Print Names of Purchasers", [d.buyerName, d.coBuyerName].filter(Boolean).join(" and "));
    setText(f, "Address City State Zip Code", addressLine({ address: d.buyerAddress, city: d.buyerCity, state: d.buyerState, zip: d.buyerZip }));
    setText(f, "2", mdy(d.deliveredOn ?? today)); // date of sale
    setText(f, "Odometer Disclosure Statement Required For a Motor Vehicle", money(d.salePrice)); // selling price
    tick(f, "6 DIGIT ODOMETER NOW READS");
    const [a, b, c, e, g, h] = digits(d.odometer);
    setText(f, "Text1", a);
    setText(f, "Federal and State law requires that you state the mileage in connection with the transfer of ownership", b);
    setText(f, "undefined_2", c);
    setText(f, "Failure to", e);
    setText(f, "undefined_3", g);
    setText(f, "xx", h);
    const read = parts(d.deliveredOn ?? today);
    setText(f, "undefined_4", read.mm);
    setText(f, "undefined_5", read.dd);
    setText(f, "AND WE HEREBY CERTIFY THAT TO THE BEST OF OUR KNOWLEDGE", read.yyyy);
    tick(f, "1 REFLECTS THE ACTUAL MILEAGE", d.odometerBrand === "actual");
    tick(f, "2 IS IN EXCESS OF ITS MECHANICAL LIMITS", d.odometerBrand === "exceeds");
    tick(f, "3 IS NOT THE ACTUAL MILEAGE", d.odometerBrand === "not_actual");
    setText(f, "Sellers Printed Name", company.name);
    setText(f, "Date", mdy(d.deliveredOn ?? today));
    setText(f, "Sellers Address City State Zip Code", (company.address ?? "").replace(/\n/g, ", "));
    setText(f, "Purchasers Printed Name", d.buyerName);
    setText(f, "Date_3", mdy(d.deliveredOn ?? today));
    setText(f, "CoPurchasers Printed name when applicable", d.coBuyerName);
    if (d.coBuyerName) setText(f, "Date_4", mdy(d.deliveredOn ?? today));
  },
  "82993": (f, { deal: d, company, today }) => {
    setText(f, "Vehicle Identification Number", d.vin);
    setText(f, "Year", d.vehicleYear);
    setText(f, "Make", d.vehicleMake);
    setText(f, "Color", d.vehicleColour);
    setText(f, "Body", d.vehicleBody);
    setText(f, "Title Number", d.titleNumber);
    tick(f, "6 DIGIT ODOMETER NOWS READS");
    const [a, b, c, e, g, h] = digits(d.odometer);
    setText(f, "Odo1", a);
    setText(f, "Odo2", b);
    setText(f, "Odo3", c);
    setText(f, "Odo4", e);
    setText(f, "Odo5", g);
    setText(f, "Odo6", h);
    const read = parts(d.deliveredOn ?? today);
    setText(f, "month", read.mm);
    setText(f, "day", read.dd);
    setText(f, "year", read.yyyy);
    tick(f, "1 REFLECTS ACTUAL MILEAGE", d.odometerBrand === "actual");
    tick(f, "2 IS IN EXCESS OF ITS MECHANICAL LIMITSEXCESS OF ITS MECHANICAL LIMITS APPLIES TO 5 DIGIT ODOMETERS", d.odometerBrand === "exceeds");
    tick(f, "3 IS NOT THE ACTUAL MILEAGE  WARNING  ODOMETER DISCREPANCY", d.odometerBrand === "not_actual");
    const c2 = companyParts(company);
    setText(f, "Sellers Printed Name", company.name);
    setText(f, "Sellers Street Address", c2.street);
    setText(f, "City", c2.city);
    setText(f, "State", c2.state);
    setText(f, "Zip", c2.zip);
    setText(f, "Buyers Printed Name", [d.buyerName, d.coBuyerName].filter(Boolean).join(" and "));
    setText(f, "Buyers Street Address", d.buyerAddress);
    setText(f, "City_2", d.buyerCity);
    setText(f, "State_2", d.buyerState);
    setText(f, "Zip_2", d.buyerZip);
  },
  "82053": (f, { deal: d, company, today }) => {
    tick(f, "Motor Vehicle");
    setText(f, "YearRow1", d.vehicleYear);
    setText(f, "MakeManufacturerRow1", d.vehicleMake);
    setText(f, "Body TypeRow1", d.vehicleBody);
    setText(f, "Title NumberRow1", d.titleNumber);
    setText(f, "Vehicle Identification Number VIN Hull Identification Number HINRow1", d.vin);
    setText(f, "Legibly Printed Name of Owner Grantor", d.buyerName);
    setText(f, "Driver License Identification Card or FEID Number of Owner", d.buyerDl);
    setText(f, "Date of Birth of Owner if applicable", mdy(d.buyerDob));
    setText(f, "Owners Address", d.buyerAddress);
    setText(f, "City", d.buyerCity);
    setText(f, "State", d.buyerState);
    setText(f, "Zip Code", d.buyerZip);
    if (d.coBuyerName) setText(f, "Legibly Printed Name of CoOwner Grantor if applicable", d.coBuyerName);
    const on = parts(d.deliveredOn ?? today);
    setText(f, "Month", on.mm);
    setText(f, "Day", on.dd);
    setText(f, "Year", on.yyyy);
    setText(f, "Full Legibly Printed Name is required", company.name); // the attorney-in-fact
  },
};

/** The filled form as PDF bytes. Fields keep their values but the form is flattened so nothing shifts when printed. */
export async function fillFloridaForm(which: FloridaForm, source: Source): Promise<Uint8Array> {
  const bytes = await readFile(path.join(process.cwd(), "forms", "florida", `${which}.pdf`));
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = pdf.getForm();
  fillers[which](form, source);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  form.updateFieldAppearances(font);
  form.flatten();
  return pdf.save();
}
