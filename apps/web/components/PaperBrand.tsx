import type { CompanyProfile } from "@bos/core";

/** The company's logo and details at the top of a printed document. */
export function PaperBrand({ company }: { company: CompanyProfile }) {
  return (
    <div className="paper-brand">
      {company.logo && <img src={company.logo} alt="" className="paper-logo" />}
      <div>
        <div className="paper-company">{company.name}</div>
        {company.address && <div className="paper-muted address">{company.address}</div>}
        {(company.phone || company.email) && <div className="paper-muted">{[company.phone, company.email].filter(Boolean).join(" · ")}</div>}
        {company.taxNumber && <div className="paper-muted">{company.taxNumber}</div>}
      </div>
    </div>
  );
}
