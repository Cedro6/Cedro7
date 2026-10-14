import Image from "next/image";
import Link from "next/link";
import { BUSINESS_TYPES, CURRENCIES, PLANS, productOf, signupLinkValid, timeZones, TRIAL_DAYS, TYPE_FEATURES } from "@bos/core";
import { SignUpForm } from "../../components/SignUpForm";
import { FEATURE_TEXT, TYPE_TEXT } from "../../lib/features";
import { pool } from "../../lib/pool";

export const dynamic = "force-dynamic";
// The link carries a secret, so it must not be passed on to other sites or kept by search engines.
export const metadata = { referrer: "no-referrer" as const, robots: { index: false } };

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ token?: string; product?: string }> }) {
  const { token = "", product } = await searchParams;
  const start = product === "dealer" ? "dealer" : "cedro";
  // With a link the company is invited; without one, anyone may sign up and the product is theirs to pick.
  const valid = token === "" || (await signupLinkValid(pool, token));
  return (
    <main className="landing signup-page">
      <header className="landing-top">
        <Link href="/" className="landing-wordmark">Cedro</Link>
        <nav className="landing-nav" aria-label="Account"><Link href="/sign-in">Sign in</Link></nav>
      </header>
      {!valid ? (
        <section className="signup-dead">
          <h1>This sign-up link does not work</h1>
          <p>It has been used already, has expired, or was not copied in full. Ask whoever sent it for a new one, or start from the <Link href="/">welcome page</Link>.</p>
        </section>
      ) : (
        <div className="signup-split">
          <aside className="signup-side">
            <div className="signup-side-cedro">
              <span className="door-mark door-mark-cedro" aria-hidden="true"><i /></span>
              <h1>Set up Cedro Terminal</h1>
              <p>Customers, orders, invoices, stock, purchasing, bills and reports, with Ava to ask. Pick the kind of business and the right tools come on; the rest can be switched on later.</p>
              <p className="signup-trial">{TRIAL_DAYS.cedro} days free with everything on. No card to start. From ${PLANS.cedro_basic.monthly} a month after that.</p>
            </div>
            <div className="signup-side-dealer">
              <Image src="/brand/dealer-terminal-white.png" alt="" width={152} height={43} className="door-logo" />
              <h1>Set up Dealer Terminal</h1>
              <p>Cars by VIN, cash deals with Florida tax worked out, the title forms and Buyers Guide filled in, Form 8300, photos, profit and tax reports, with Ava to ask.</p>
              <p className="signup-trial">{TRIAL_DAYS.dealer} days free with everything on. No card to start. ${PLANS.dealer.monthly} a month after that, {PLANS.dealer.includedUsers} people included.</p>
            </div>
            <p className="signup-side-note">About two minutes. You&apos;ll be the owner and can add your team afterwards.</p>
          </aside>
          <section className="signup-formwrap">
            <SignUpForm
              token={token}
              start={start}
              zones={timeZones()}
              currencies={CURRENCIES.map((code) => ({ code, label: `${code} (${(0).toLocaleString("en-US", { style: "currency", currency: code, maximumFractionDigits: 0 }).replace(/[\d\s]/g, "")})` }))}
              kinds={BUSINESS_TYPES.map((id) => ({ id, name: TYPE_TEXT[id].name, about: TYPE_TEXT[id].about, product: productOf(id), tools: TYPE_FEATURES[id].map((f) => FEATURE_TEXT[f].name) }))}
            />
          </section>
        </div>
      )}
    </main>
  );
}
