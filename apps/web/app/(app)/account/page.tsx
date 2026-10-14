import QRCode from "qrcode";
import { pendingTwoStep, sessionVersion, twoStepStatus } from "@bos/core";
import { TwoStepSetup } from "../../../components/TwoStepSetup";
import { pool } from "../../../lib/pool";
import { requireSession } from "../../../lib/session";
import Link from "next/link";
import { isPlatformAdmin } from "../../../lib/platform";
import { signOut } from "../actions";
import { changePassword, startSetup, turnOffTwoStep } from "./actions";

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string; required?: string }> }) {
  const { ctx, membership } = await requireSession({ setupAllowed: true, billingAllowed: true });
  const { error, notice, required } = await searchParams;
  const hasPassword = (await sessionVersion(pool, ctx.userId)) > 0;
  const twoStep = hasPassword ? await twoStepStatus(pool, ctx.userId) : { on: false, recoveryLeft: 0 };
  const pending = hasPassword && !twoStep.on ? await pendingTwoStep(ctx, "Clivada") : null;
  const qr = pending ? await QRCode.toString(pending.uri, { type: "svg", margin: 1, width: 200 }) : "";
  const role = membership.role[0]!.toUpperCase() + membership.role.slice(1);
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            {role} at {membership.orgName}
          </div>
          <h1>{membership.userName}</h1>
        </div>
        {isPlatformAdmin(membership.userEmail) && (
          <Link href="/platform" className="btn btn-glass">
            Platform
          </Link>
        )}
        <form action={signOut}>
          <button type="submit" className="btn btn-glass">
            Sign out
          </button>
        </form>
      </header>
      {required && hasPassword && !twoStep.on && <p className="error">{membership.orgName} requires two-step verification. Set it up below to carry on. It takes about a minute.</p>}
      {error && <p className="error">{error}</p>}
      {notice && !error && <p className="notice">{notice}</p>}
      <section className="glass panel form-panel">
        <h2 className="title">Change your password</h2>
        {hasPassword ? (
          <form action={changePassword} className="stack">
            <label className="field">
              <span>Current password</span>
              <input type="password" name="current" required maxLength={200} autoComplete="current-password" />
            </label>
            <label className="field">
              <span>New password</span>
              <input type="password" name="next" required minLength={10} maxLength={200} autoComplete="new-password" />
            </label>
            <label className="field">
              <span>Type the new one again</span>
              <input type="password" name="again" required minLength={10} maxLength={200} autoComplete="new-password" />
            </label>
            <p className="muted">At least 10 characters. Changing it signs you out everywhere except here.</p>
            <div className="actions">
              <button type="submit" className="btn btn-primary">
                Change password
              </button>
            </div>
          </form>
        ) : (
          <p className="muted">This is a demo person with no password of their own. To get a personal login, ask an owner to add you under Settings, then Team.</p>
        )}
      </section>
      {hasPassword && (
        <section className="glass panel form-panel" id="two-step">
          <h2 className="title">Two-step verification</h2>
          {twoStep.on ? (
            <div className="stack">
              <p>
                <span className="badge badge-ok">On</span> Signing in asks for a code from your authenticator app after your password.{" "}
                {twoStep.recoveryLeft} of 8 recovery codes left.
              </p>
              <details className="return-form">
                <summary className="btn btn-glass btn-small">Turn it off</summary>
                <form action={turnOffTwoStep} className="stack">
                  <p className="muted">To get new recovery codes or move to a new phone, turn it off and set it up again.</p>
                  <label className="field">
                    <span>Your password</span>
                    <input type="password" name="password" required maxLength={200} autoComplete="current-password" />
                  </label>
                  <label className="field">
                    <span>Current code from the app, or a recovery code</span>
                    <input name="code" required maxLength={20} autoComplete="one-time-code" />
                  </label>
                  <div className="actions">
                    <button type="submit" className="btn btn-glass">Turn off two-step verification</button>
                  </div>
                </form>
              </details>
            </div>
          ) : pending ? (
            <TwoStepSetup qr={qr} secret={pending.secret} />
          ) : (
            <form action={startSetup} className="stack">
              <p className="muted">Adds a second lock on your account: after your password, sign-in asks for a 6-digit code from an app on your phone. Someone who learns your password still cannot get in.</p>
              <div className="actions">
                <button type="submit" className="btn btn-primary">Set up two-step verification</button>
              </div>
            </form>
          )}
        </section>
      )}
    </>
  );
}
