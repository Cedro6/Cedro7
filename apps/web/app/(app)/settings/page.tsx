import { redirect } from "next/navigation";
import { BUSINESS_TYPES, can, FEATURES, getSettings, NEEDS_STOCK, TYPE_FEATURES } from "@bos/core";
import { BUILT, FEATURE_TEXT, TYPE_TEXT } from "../../../lib/features";
import { requireSession } from "../../../lib/session";
import { chooseType, switchFeature } from "./actions";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { ctx, membership } = await requireSession();
  if (!can(ctx, "settings.manage")) redirect("/");
  const { error, notice } = await searchParams;
  const settings = await getSettings(ctx);
  const starting = TYPE_FEATURES[settings.businessType];
  const customized = FEATURES.some((id) => settings.features[id] !== starting.includes(id));
  const onCount = FEATURES.filter((id) => settings.features[id]).length;
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">{membership.orgName}</div>
          <h1>Settings</h1>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      {notice && !error && <p className="notice">{notice}</p>}

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
          {BUSINESS_TYPES.map((type) => (
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
                {TYPE_FEATURES[type].length} of {FEATURES.length} tools
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
            {onCount} of {FEATURES.length} on
          </span>
        </div>
        <div className="feature-grid">
          {FEATURES.map((id) => {
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
  );
}
