import Link from "next/link";
import { BUSINESS_TYPES, CURRENCIES, signupLinkValid, timeZones, TYPE_FEATURES } from "@bos/core";
import { SignUpForm } from "../../components/SignUpForm";
import { FEATURE_TEXT, TYPE_TEXT } from "../../lib/features";
import { pool } from "../../lib/pool";

export const dynamic = "force-dynamic";
// The link carries a secret, so it must not be passed on to other sites or kept by search engines.
export const metadata = { referrer: "no-referrer" as const, robots: { index: false } };

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const valid = await signupLinkValid(pool, token);
  return (
    <main className="sign-in">
      <section className={`glass panel sign-in-card ${valid ? "signup-card" : ""}`}>
        <div className="brand">Cedro Terminal</div>
        {!valid ? (
          <>
            <h1>This sign-up link does not work</h1>
            <p className="muted">It has been used already, has expired, or was not copied in full. Sign-up is by invitation: ask whoever sent it for a new link.</p>
            <Link href="/sign-in" className="btn btn-glass">I already have a login</Link>
          </>
        ) : (
          <>
            <h1>Set up your company</h1>
            <p className="muted">About two minutes. Your company starts empty, with only the tools that fit your kind of business switched on.</p>
            <SignUpForm
              token={token}
              zones={timeZones()}
              currencies={CURRENCIES.map((code) => ({ code, label: `${code} (${(0).toLocaleString("en-US", { style: "currency", currency: code, maximumFractionDigits: 0 }).replace(/[\d\s]/g, "")})` }))}
              kinds={BUSINESS_TYPES.map((id) => ({ id, name: TYPE_TEXT[id].name, about: TYPE_TEXT[id].about, tools: TYPE_FEATURES[id].map((f) => FEATURE_TEXT[f].name) }))}
            />
          </>
        )}
      </section>
    </main>
  );
}
