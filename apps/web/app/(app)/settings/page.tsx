import Link from "next/link";
import { redirect } from "next/navigation";
import { ADD_ONS, CEDRO_TYPES, can, FEATURES, productOf, CURRENCIES, getCompanyProfile, getRegion, getSettings, timeZones, listMembers, NEEDS_STOCK, TYPE_FEATURES } from "@bos/core";
import { TeamPanel } from "../../../components/TeamPanel";
import { BUILT, FEATURE_TEXT, TYPE_TEXT } from "../../../lib/features";
import { requireSession } from "../../../lib/session";
import { chooseType, saveCompany, saveLogo, saveRegion, saveTwoStepRule, switchFeature } from "./actions";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { ctx, membership } = await requireSession();
  if (!can(ctx, "settings.manage")) redirect("/");
  const { error, notice } = await searchParams;
  const [settings, company, members, region] = await Promise.all([getSettings(ctx), getCompanyProfile(ctx), listMembers(ctx), getRegion(ctx)]);
  const dealer = productOf(settings.businessType) === "dealer";
  const starting = TYPE_FEATURES[settings.businessType];
  const customized = FEATURES.some((id) => settings.features[id] !== starting.includes(id));
  const onCount = FEATURES.filter((id) => !ADD_ONS.includes(id) && settings.features[id]).length;
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">{membership.orgName}</div>
          <h1>Settings</h1>
        </div>
        <Link href="/settings/history" className="btn btn-glass">Activity history</Link>
      </header>
      {error && <p className="error">{error}</p>}
      {notice && !error && <p className="notice">{notice}</p>}

      <section className="glass panel">
        <h2 className="title">Company details</h2>
        <div className="muted">These print at the top of your invoices.</div>
        <div className="split company-split">
          <form action={saveCompany} className="stack grow-3">
            <label className="field">
              <span>Company name</span>
              <input name="name" required maxLength={200} defaultValue={company.name} />
            </label>
            <label className="field">
              <span>Address</span>
              <textarea name="address" rows={3} maxLength={500} defaultValue={company.address ?? ""} placeholder={"12 Dock Road\nPortland, ME 04101"} />
            </label>
            <div className="form-row">
              <label className="field">
                <span>Phone</span>
                <input name="phone" maxLength={50} defaultValue={company.phone ?? ""} />
              </label>
              <label className="field">
                <span>Email</span>
                <input name="email" type="email" maxLength={200} defaultValue={company.email ?? ""} />
              </label>
            </div>
            <label className="field">
              <span>Tax number</span>
              <input name="taxNumber" maxLength={60} defaultValue={company.taxNumber ?? ""} placeholder="EIN 12-3456789" />
            </label>
            <label className="field">
              <span>Line at the bottom of every invoice</span>
              <textarea name="invoiceFooter" rows={2} maxLength={500} defaultValue={company.invoiceFooter ?? ""} placeholder="Thank you for your business. Pay by bank transfer to…" />
            </label>
            <div className="actions">
              <button type="submit" className="btn btn-primary">
                Save details
              </button>
            </div>
          </form>
          <div className="stack grow-2">
            <div className="field">
              <span>Logo</span>
              {company.logo ? (
                <img src={company.logo} alt={`${company.name} logo`} className="logo-preview" />
              ) : (
                <div className="muted">No logo yet. Invoices show the company name on its own.</div>
              )}
            </div>
            <form action={saveLogo} className="stack">
              <label className="field">
                <span>{company.logo ? "Replace it" : "Add one"} (PNG, JPEG or WebP, under 200 KB)</span>
                <input name="logo" type="file" accept="image/png,image/jpeg,image/webp" required />
              </label>
              <div className="actions">
                <button type="submit" className="btn btn-glass">
                  Upload logo
                </button>
              </div>
            </form>
            {company.logo && (
              <form action={saveLogo}>
                <input type="hidden" name="remove" value="1" />
                <button type="submit" className="link-button">
                  Remove logo
                </button>
              </form>
            )}
          </div>
        </div>
      </section>

      <section className="glass panel">
        <h2 className="title">Region and tax</h2>
        <p className="muted">These decide what counts as today, how amounts are written, and the tax on a new order or invoice.</p>
        <form action={saveRegion} className="stack">
          <div className="form-row">
            <label className="field grow">
              <span>Time zone</span>
              <select name="timeZone" defaultValue={region.timeZone}>
                {timeZones().map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
              </select>
            </label>
            <label className="field grow">
              <span>Currency</span>
              <select name="currency" defaultValue={region.currency}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c} ({(0).toLocaleString("en-US", { style: "currency", currency: c, maximumFractionDigits: 0 }).replace(/[\d\s]/g, "")})</option>)}
              </select>
            </label>
            <label className="field tax-field">
              <span>Usual tax %</span>
              <input name="defaultTaxPercent" type="number" min="0" max="99" step="any" inputMode="decimal" defaultValue={region.defaultTaxPercent} />
            </label>
          </div>
          <p className="muted">Changing the currency changes the symbol only. Amounts already entered are not converted. A customer can be marked as not charged tax on their own page.</p>
          <div className="actions">
            <button type="submit" className="btn btn-primary">Save region and tax</button>
          </div>
        </form>
      </section>

      <section className="glass panel">
        <h2 className="title">Security</h2>
        <form action={saveTwoStepRule} className="stack">
          <label className="bill-choice">
            <input type="checkbox" name="requireTwoStep" value="1" defaultChecked={membership.requireTwoStep} /> <span>Require two-step verification for everyone with a password</span>
          </label>
          <p className="muted">
            Anyone who has not set it up is sent to do so the next time they open the app, and cannot use anything else until they have.
            You need it on for your own login before you can require it. {members.filter((m) => m.hasPassword && m.status === "active" && !m.twoStep).length} of your team would need to set it up.
          </p>
          <div className="actions">
            <button type="submit" className="btn btn-glass">Save</button>
          </div>
        </form>
      </section>

      <section className="glass panel">
        <h2 className="title">Team</h2>
        <div className="muted">Everyone who can sign in to {company.name}, and what their role lets them do.</div>
        <TeamPanel members={members} canMakeOwners={ctx.role === "owner"} />
      </section>

      {dealer ? (
        <section className="glass panel">
          <h2 className="title">Dealer Terminal membership</h2>
          <p className="muted">Your tools are set by the membership: vehicles, deals, compliance paperwork, customers, calendar, reports, bills and Ava. There is nothing to switch on or off. To change the membership, contact support.</p>
        </section>
      ) : (
        <>
      <section className="glass panel">
        <div className="panel-head">
          <div>
            <h2 className="title">Business type</h2>
            <div className="muted">
              Pick the one closest to you. It switches on the tools that kind of business uses; you can change any of them below.
            </div>
          </div>
          {customized && <span className="badge badge-info">Customized</span>}
        </div>
        <form action={chooseType} className="type-grid">
          {CEDRO_TYPES.map((type) => (
            <button
              key={type}
              type="submit"
              name="businessType"
              value={type}
              className="type-card"
              aria-pressed={type === settings.businessType}
            >
              <span className="type-name">{TYPE_TEXT[type].name}</span>
              <span className="muted">{TYPE_TEXT[type].about}</span>
              <span className="type-count">
                {TYPE_FEATURES[type].length} of {FEATURES.length - ADD_ONS.length} tools
              </span>
            </button>
          ))}
        </form>
        <p className="muted footnote">Choosing a type resets every switch below to that type&apos;s starting set.</p>
      </section>

      <section className="glass panel">
        <div className="panel-head">
          <div>
            <h2 className="title">Features</h2>
            <div className="muted">
              Customers, products, orders and invoices are always on. Your business type starts you with what it usually needs; add anything
              else here.
            </div>
          </div>
          <span className="muted">
            {onCount} of {FEATURES.length - ADD_ONS.length} on
          </span>
        </div>
        <div className="feature-grid">
          {FEATURES.filter((id) => !ADD_ONS.includes(id)).map((id) => {
            const on = settings.features[id];
            const locked = NEEDS_STOCK.includes(id) && !settings.features.stock;
            return (
              <div className="feature" key={id}>
                <div className="row-text">
                  <div className="row-title">{FEATURE_TEXT[id].name}</div>
                  <div className="muted">{FEATURE_TEXT[id].about}</div>
                  {locked && <div className="muted">Turn on Stock and shipping first.</div>}
                  {!BUILT.includes(id) && <div className="muted">Screens coming later.</div>}
                </div>
                <form action={switchFeature}>
                  <input type="hidden" name="feature" value={id} />
                  <input type="hidden" name="on" value={on ? "0" : "1"} />
                  <button type="submit" className="switch" role="switch" aria-checked={on} aria-label={FEATURE_TEXT[id].name} disabled={locked}>
                    <span />
                  </button>
                </form>
              </div>
            );
          })}
        </div>
      </section>
        </>
      )}
    </>
  );
}
