"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createCompany, type SignUpState } from "../app/sign-up/actions";

type Kind = { id: string; name: string; about: string; product: "cedro" | "dealer"; tools: string[] };
const START: SignUpState = { error: "", field: "", values: {} };

/** Three short steps on one page: the company, where it is, and the owner's own login. */
export function SignUpForm({ token, kinds, zones, currencies, start = "cedro" }: { token: string; kinds: Kind[]; zones: string[]; currencies: { code: string; label: string }[]; start?: "cedro" | "dealer" }) {
  const [state, action, busy] = useActionState(createCompany, START);
  const [product, setProduct] = useState<"cedro" | "dealer">(state.values?.businessType ? (state.values.businessType === "dealer" ? "dealer" : "cedro") : start);
  const v = state.values;
  const zone = useRef<HTMLSelectElement>(null);
  // Start on the visitor's own time zone when their browser reports one we know.
  useEffect(() => {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone.current && zones.includes(here) && !zone.current.dataset.touched && !v.timeZone) zone.current.value = here;
  }, [zones, v.timeZone]);
  return (
    <form action={action} className="stack signup-form" key={JSON.stringify(v)}>
      <input type="hidden" name="token" value={token} />
      {state.error && <p className="error" role="alert">{state.error}</p>}

      <fieldset className="signup-step">
        <legend>1. Your company</legend>
        <label className="field">
          <span>Company name</span>
          <input name="company" required maxLength={200} autoFocus autoComplete="organization" defaultValue={v.company ?? ""} />
        </label>
        <div className="field">
          <span id="product-label">Product</span>
          <div className="signup-kinds signup-products" role="radiogroup" aria-labelledby="product-label">
            <label className="signup-kind signup-kind-cedro">
              <input type="radio" name="product" value="cedro" checked={product === "cedro"} onChange={() => setProduct("cedro")} />
              <span className="type-name">Clivada</span>
              <span className="muted">For businesses that buy, stock and sell things.</span>
            </label>
            <label className="signup-kind signup-kind-dealer">
              <input type="radio" name="product" value="dealer" checked={product === "dealer"} onChange={() => setProduct("dealer")} />
              <span className="type-name">Dealer Terminal</span>
              <span className="muted">For Florida used-car lots selling for cash.</span>
            </label>
          </div>
        </div>
        {product === "dealer" ? (
          <input type="hidden" name="businessType" value="dealer" />
        ) : (
          <div className="field">
            <span id="kind-label">What kind of business is it?</span>
            <div className="signup-kinds" role="radiogroup" aria-labelledby="kind-label">
              {kinds.filter((k) => k.product === "cedro").map((k, i) => (
                <label key={k.id} className="signup-kind">
                  <input type="radio" name="businessType" value={k.id} required defaultChecked={v.businessType ? v.businessType === k.id : i === 0} />
                  <span className="type-name">{k.name}</span>
                  <span className="muted">{k.about}</span>
                  <span className="signup-tools">Starts with: {k.tools.join(", ")}</span>
                </label>
              ))}
            </div>
            <span className="muted">This only decides which tools are switched on to begin with. You can turn any of them on or off later in Settings.</span>
          </div>
        )}
      </fieldset>

      <fieldset className="signup-step">
        <legend>2. Where you are</legend>
        <div className="form-row">
          <label className="field grow">
            <span>Time zone</span>
            <select name="timeZone" ref={zone} defaultValue={v.timeZone || "America/New_York"} onChange={(e) => { e.currentTarget.dataset.touched = "1"; }}>
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </select>
          </label>
          <label className="field grow">
            <span>Currency</span>
            <select name="currency" defaultValue={v.currency || "USD"}>
              {currencies.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </label>
          <label className="field tax-field">
            <span>Usual tax %</span>
            <input name="taxPercent" type="number" min="0" max="99" step="any" inputMode="decimal" placeholder="0" defaultValue={v.taxPercent ?? ""} />
          </label>
        </div>
      </fieldset>

      <fieldset className="signup-step">
        <legend>3. Your login</legend>
        <div className="form-row">
          <label className="field grow">
            <span>Your name</span>
            <input name="name" required maxLength={120} autoComplete="name" defaultValue={v.name ?? ""} />
          </label>
          <label className="field grow">
            <span>Your email</span>
            <input name="email" type="email" required maxLength={200} autoComplete="username" defaultValue={v.email ?? ""} />
          </label>
        </div>
        <div className="form-row">
          <label className="field grow">
            <span>Password</span>
            <input name="password" type="password" required minLength={10} maxLength={200} autoComplete="new-password" />
          </label>
          <label className="field grow">
            <span>Type it again</span>
            <input name="again" type="password" required minLength={10} maxLength={200} autoComplete="new-password" />
          </label>
        </div>
        <p className="muted">At least 10 characters. A few unrelated words is strong and easy to remember. You will be the owner and can add your team afterwards.</p>
      </fieldset>

      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Setting up…" : product === "dealer" ? "Start Dealer Terminal" : "Start Clivada"}</button>
    </form>
  );
}
