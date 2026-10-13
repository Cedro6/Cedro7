import Link from "next/link";
import { redirect } from "next/navigation";
import { readPending } from "../../../lib/session";
import { verifyCode } from "../actions";

export const dynamic = "force-dynamic";

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (!(await readPending())) redirect("/sign-in?error=expired");
  const { error } = await searchParams;
  return (
    <main className="sign-in">
      <section className="glass panel sign-in-card">
        <div className="brand">Cedro Terminal</div>
        <h1>Enter your code</h1>
        <form action={verifyCode} className="stack">
          {error === "wrong" && <p className="error">That code is not right, or it was already used. Wait for the app to show a new one and try again.</p>}
          <label className="field">
            <span>6-digit code from your authenticator app</span>
            <input name="code" required autoFocus autoComplete="one-time-code" inputMode="numeric" maxLength={20} placeholder="123 456" />
          </label>
          <p className="muted">No phone to hand? Type one of your recovery codes instead. Each works once.</p>
          <div className="actions">
            <button type="submit" className="btn btn-primary">Continue</button>
            <Link href="/sign-in" className="btn btn-glass">Start again</Link>
          </div>
        </form>
      </section>
    </main>
  );
}
