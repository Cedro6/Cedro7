import Link from "next/link";
import { passwordLinkOwner } from "@bos/core";
import { pool } from "../../lib/pool";
import { choosePassword } from "./actions";

export const dynamic = "force-dynamic";
// The link carries a secret, so it must not be passed on to other sites or kept by search engines.
export const metadata = { referrer: "no-referrer" as const, robots: { index: false } };

export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token = "", error } = await searchParams;
  const owner = await passwordLinkOwner(pool, token);
  return (
    <main className="sign-in">
      <section className="glass panel sign-in-card">
        <div className="brand">
          <img src="/brand/clivada-white.png" alt="Clivada" className="brand-logo brand-logo-on-dark" width={760} height={144} />
          <img src="/brand/clivada-dark.png" alt="" aria-hidden="true" className="brand-logo brand-logo-on-light" width={760} height={144} />
        </div>
        {!owner ? (
          <>
            <h1>This link no longer works</h1>
            <p className="muted">It has been used already or has expired. Ask your company&apos;s owner to send you a new one.</p>
            <Link href="/sign-in" className="btn btn-glass">
              Go to sign in
            </Link>
          </>
        ) : (
          <>
            <h1>{owner.purpose === "invite" ? `Welcome, ${owner.name.split(" ")[0]}` : "Choose a new password"}</h1>
            <p className="muted">
              {owner.purpose === "invite" ? `You have been added to the ${owner.orgName} team. Choose a password to finish.` : `For ${owner.email} at ${owner.orgName}.`}
            </p>
            <form action={choosePassword} className="stack">
              {error && <p className="error">{error}</p>}
              <input type="hidden" name="token" value={token} />
              <input type="email" name="username" value={owner.email} readOnly hidden autoComplete="username" />
              <label className="field">
                <span>New password</span>
                <input type="password" name="password" required minLength={10} maxLength={200} autoComplete="new-password" />
              </label>
              <label className="field">
                <span>Type it again</span>
                <input type="password" name="again" required minLength={10} maxLength={200} autoComplete="new-password" />
              </label>
              <p className="muted">At least 10 characters. A few unrelated words is strong and easy to remember.</p>
              <button type="submit" className="btn btn-primary">
                Save password and sign in
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
