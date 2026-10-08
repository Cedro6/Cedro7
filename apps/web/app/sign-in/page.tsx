import { devSignInEnabled } from "../../lib/session";
import { signIn } from "./actions";

export const dynamic = "force-dynamic";

const demoPeople = [
  { email: "amara@harborsupply.example", label: "Amara Okafor", role: "Owner" },
  { email: "luis@harborsupply.example", label: "Luis Delgado", role: "Sales" },
  { email: "priya@harborsupply.example", label: "Priya Raman", role: "Warehouse" },
];

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const enabled = devSignInEnabled();
  return (
    <main className="sign-in">
      <section className="glass panel sign-in-card">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          BusinessOS
        </div>
        <h1>Sign in</h1>
        {enabled ? (
          <>
            <p className="muted">
              Development sign-in. There is no password yet; choose a demo person to see the product as their role.
            </p>
            {error === "unknown" && <p className="error">No active account uses that email.</p>}
            <div className="stack">
              {demoPeople.map((person) => (
                <form key={person.email} action={signIn}>
                  <input type="hidden" name="email" value={person.email} />
                  <button type="submit" className="person">
                    <span>{person.label}</span>
                    <span className="muted">{person.role}</span>
                  </button>
                </form>
              ))}
            </div>
            <form action={signIn} className="stack">
              <label className="field">
                <span>Or enter an email</span>
                <input type="email" name="email" required autoComplete="email" />
              </label>
              <button type="submit" className="btn btn-primary">
                Continue
              </button>
            </form>
          </>
        ) : (
          <p className="muted">Sign-in is not available yet on this deployment.</p>
        )}
      </section>
    </main>
  );
}
