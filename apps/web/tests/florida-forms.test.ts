import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { CompanyProfile, Deal, DealerSettings } from "@bos/core";
import { fillFloridaForm, FLORIDA_FORMS, type FloridaForm } from "../lib/florida-forms";

// The filler sets every field by name and throws when one is missing, so filling each form from a
// complete deal proves the names still match the state's PDFs.
const deal = {
  id: "d", number: "DL-000009", status: "delivered", vehicleId: "v", stockNumber: "STK-1", vin: "1HGCM82633A004352", vehicleName: "2019 Honda Accord",
  vehicleYear: 2019, vehicleMake: "Honda", vehicleModel: "Accord", vehicleColour: "Silver", vehicleBody: "Sedan", titleNumber: "123456789", titleState: "GA",
  buyerName: "Maria Lopez", coBuyerName: "Ana Lopez", buyerAddress: "12 Palm St", buyerCity: "Tampa", buyerState: "FL", buyerZip: "33602", buyerCounty: "Hillsborough",
  buyerPhone: "813-555-0100", buyerEmail: "maria@example.com", buyerDl: "L123-456-78-901-0", buyerDob: "1985-04-12", buyerSex: "F",
  salePrice: 17995, dealerFee: 499, tradeAllowance: 0, taxable: 18494, stateTax: 1109.64, surtax: 75, tagTitleFees: 225, otherFees: 0, total: 19903.64,
  odometer: 48210, odometerBrand: "actual", soldAsIs: true, deliveredOn: "2026-10-13", payments: [],
} as unknown as Deal;
const company = { name: "Harbor Auto Sales", address: "500 Harbor Way\nTampa, FL 33602", phone: "813-555-0199", email: null, taxNumber: null, invoiceFooter: null, logo: null } as CompanyProfile;
const dealer = { licence: "VI-12345", county: "Hillsborough", surtaxPct: 1.5, dealerFee: 499, tagTitleFees: 225, stockNumberStyle: "counter", stockNumberPrefix: "STK" } as DealerSettings;

beforeAll(() => process.chdir(path.join(__dirname, "..")));

describe("Florida title forms", () => {
  for (const form of Object.keys(FLORIDA_FORMS) as FloridaForm[]) {
    it(`fills HSMV ${form} from a deal`, async () => {
      const bytes = await fillFloridaForm(form, { deal, company, dealer, today: "2026-10-13" });
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
      expect(pdf.getPageCount()).toBeGreaterThan(0);
      // Flattened: nothing left to edit, so nothing shifts when printed.
      expect(pdf.getForm().getFields()).toHaveLength(0);
    });
  }

  it("includes the out-of-state VIN verification", () => {
    expect(Object.keys(FLORIDA_FORMS)).toEqual(expect.arrayContaining(["82040", "82042", "82050", "82053", "82993"]));
  });
});
