"use client";

import { useActionState } from "react";
import { makeLink, type LinkState } from "../app/(app)/platform/actions";

const START: LinkState = { error: "", link: "", note: "" };

export function SignupLinkMaker() {
  const [state, action, busy] = useActionState(makeLink, START);
  return (
    <div className="stack">
      <form action={action} className="form-row bill-inline">
        <label className="field grow">
          <span>Who is it for?</span>
          <input name="note" required maxLength={200} placeholder="Dana at Bayside Hardware" />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Making…" : "Make sign-up link"}</button>
      </form>
      <div aria-live="polite">
        {state.error && <p className="error">{state.error}</p>}
        {state.link && (
          <div className="change link-box">
            <div className="change-label">Sign-up link for {state.note}</div>
            <p className="muted">Send this to them yourself. It works once, for 14 days, and will not be shown again. Whoever opens it creates a company and becomes its owner.</p>
            <input className="link-field mono" readOnly value={state.link} aria-label="Sign-up link" onFocus={(event) => event.currentTarget.select()} />
            <button type="button" className="btn btn-glass btn-small" onClick={() => void navigator.clipboard?.writeText(state.link).catch(() => undefined)}>Copy link</button>
          </div>
        )}
      </div>
    </div>
  );
}
