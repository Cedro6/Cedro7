import Link from "next/link";
import { devSignInEnabled, previewPasswordRequired } from "../../lib/session";
import { signIn, signInWithEmail } from "./actions";

export const dynamic = "force-dynamic";

const demoPeople = [
  { email: "amara@harborsupply.example", label: "Amara Okafor", role: "Owner" },
  { email: "luis@harborsupply.example", label: "Luis Delgado", role: "Sales" },
  { email: "priya@harborsupply.example", label: "Priya Raman", role: "Warehouse" },
];

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const enabled = devSignInEnabled();
  const needsPassword = previewPasswordRequired();
  return (
    <main className="sign-in">
      <section className="glass panel sign-in-card">
        <div className="brand">
          Cedro Terminal
        </div>
        <h1>Sign in</h1>
        <form action={signInWithEmail} className="stack">
          {error === "wrong" && <p className="error">That email or password is not right.</p>}
          {error === "expired" && <p className="error">That took too long. Sign in again.</p>}
          {error === "suspended" && <p className="error">This company&apos;s account has been suspended. Contact whoever provides Cedro Terminal to you.</p>}
          {error === "locked" && <p className="error">Too many wrong passwords. Try again in 15 minutes, or ask your company&apos;s owner for a new sign-in link.</p>}
          {error === "has-password" && <p className="error">That person now has their own password. Sign in with their email and password.</p>}
          <label className="field">
            <span>Email</span>
            <input type="email" name="email" required autoComplete="username" maxLength={200} />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" name="password" required autoComplete="current-password" maxLength={200} />
          </label>
          <button type="submit" className="btn btn-primary">
            Sign in
          </button>
          <p className="muted">Forgotten it? Ask your company&apos;s owner for a sign-in link.</p>
          <p className="muted">New here? <Link href="/sign-up" className="row-link">Create your company</Link>. Cedro Terminal or Dealer Terminal, about two minutes.</p>
        </form>
        {enabled && <hr className="rule" />}
        {enabled ? (
          <form action={signIn} className="stack">
            <p className="muted">
              {needsPassword
                ? "Preview. Enter the preview password, then choose a demo person to see the product as their role."
                : "Development sign-in. Choose a demo person to see the product as their role."}
            </p>
            {error === "unknown" && <p className="error">No active account uses that email.</p>}
            {error === "password" && <p className="error">That preview password is not right.</p>}
            {needsPassword && (
              <label className="field">
                <span>Preview password</span>
                <input type="password" name="previewPassword" required autoComplete="off" />
              </label>
            )}
            <div className="stack">
              {demoPeople.map((person) => (
                <button key={person.email} type="submit" name="email" value={person.email} className="person">
                  <span>{person.label}</span>
                  <span className="muted">{person.role}</span>
                </button>
              ))}
            </div>
          </form>
        ) : null}
      </section>
    </main>
  );
}
