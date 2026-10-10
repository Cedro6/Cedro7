import { devSignInEnabled, previewPasswordRequired } from "../../lib/session";
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
  const needsPassword = previewPasswordRequired();
  return (
    <main className="sign-in">
      <section className="glass panel sign-in-card">
        <div className="brand">
          Cedro Terminal
        </div>
        <h1>Sign in</h1>
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
                <input type="password" name="previewPassword" required autoComplete="current-password" />
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
        ) : (
          <p className="muted">Sign-in is not available yet on this deployment.</p>
        )}
      </section>
    </main>
  );
}
