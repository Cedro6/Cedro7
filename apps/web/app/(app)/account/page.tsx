import { sessionVersion } from "@bos/core";
import { pool } from "../../../lib/pool";
import { requireSession } from "../../../lib/session";
import { changePassword } from "./actions";

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { ctx, membership } = await requireSession();
  const { error, notice } = await searchParams;
  const hasPassword = (await sessionVersion(pool, ctx.userId)) > 0;
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
      </header>
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
    </>
  );
}
