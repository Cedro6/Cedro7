"use client";

import { useActionState } from "react";
import { confirmSetup, type SetupState } from "../app/(app)/account/actions";

const START: SetupState = { error: "", codes: [] };

/** Scan the QR code, type the code the app shows, then keep the recovery codes that appear once. */
export function TwoStepSetup({ qr, secret }: { qr: string; secret: string }) {
  const [state, action, busy] = useActionState(confirmSetup, START);
  if (state.codes.length > 0) {
    return (
      <div className="stack">
        <p className="notice" role="status">Two-step verification is on.</p>
        <p><strong>Save these recovery codes now.</strong> They are shown only this once. Each one signs you in a single time if you cannot use your phone.</p>
        <ul className="recovery-codes mono">
          {state.codes.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <div className="actions">
          <button type="button" className="btn btn-glass" onClick={() => navigator.clipboard.writeText(state.codes.join("\n")).catch(() => {})}>Copy them</button>
          <a href="/account" className="btn btn-primary">I have saved them</a>
        </div>
      </div>
    );
  }
  return (
    <div className="stack">
      <ol className="twostep-steps">
        <li>Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password, Authy or similar).</li>
        <li>Choose to add an account and scan this code.</li>
        <li>Type the 6-digit code the app shows.</li>
      </ol>
      <div className="twostep-qr" role="img" aria-label="QR code to scan with your authenticator app" dangerouslySetInnerHTML={{ __html: qr }} />
      <p className="muted">Cannot scan? Enter this key in the app by hand: <span className="mono twostep-key">{secret.match(/.{1,4}/g)?.join(" ")}</span></p>
      <form action={action} className="form-row bill-inline">
        <label className="field grow">
          <span>Code from the app</span>
          <input name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={10} placeholder="123 456" />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Checking…" : "Turn on"}</button>
      </form>
      {state.error && <p className="error" role="alert">{state.error}</p>}
    </div>
  );
}
