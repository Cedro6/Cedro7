import Link from "next/link";
import { can, featureOn, FEATURES, getCompanyProfile, getSettings, listCustomers, listMembers, listProducts, twoStepStatus } from "@bos/core";
import { FEATURE_TEXT, TYPE_TEXT } from "../../../lib/features";
import { pool } from "../../../lib/pool";
import { requireSession } from "../../../lib/session";

/** A short list of first things to do, each ticked off from what is really in the company so far. */
export default async function WelcomePage() {
  const { ctx, membership } = await requireSession();
  const manage = can(ctx, "settings.manage");
  const [settings, company, customers, products, members, twoStep] = await Promise.all([
    getSettings(ctx), getCompanyProfile(ctx),
    can(ctx, "customer.read") ? listCustomers(ctx) : [], can(ctx, "product.read") ? listProducts(ctx) : [],
    manage ? listMembers(ctx) : [], twoStepStatus(pool, ctx.userId),
  ]);
  const on = FEATURES.filter((f) => featureOn(settings.features, f));
  const steps: { done: boolean; title: string; about: string; href: string; action: string }[] = [
    ...(manage ? [{ done: Boolean(company.address || company.logo), title: "Add your address and logo", about: "They go at the top of every invoice, packing slip and purchase order.", href: "/settings", action: "Open Settings" }] : []),
    ...(can(ctx, "product.write") ? [{ done: products.length > 0, title: "Bring in your products", about: "Import them from a spreadsheet with their prices and stock on hand, or add one by hand.", href: "/import?kind=products", action: "Import products" }] : []),
    ...(can(ctx, "customer.write") ? [{ done: customers.length > 0, title: "Bring in your customers", about: "Import them from a spreadsheet with their contacts and addresses, or add one by hand.", href: "/import?kind=customers", action: "Import customers" }] : []),
    ...(manage ? [{ done: members.length > 1, title: "Add your team", about: "Each person gets their own login and a role that decides what they can see and do.", href: "/settings", action: "Add people" }] : []),
    { done: twoStep.on, title: "Turn on two-step verification", about: "A code from your phone after your password, so a stolen password is not enough.", href: "/account#two-step", action: "Set it up" },
  ];
  const left = steps.filter((s) => !s.done).length;
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">{membership.orgName} · set up as {TYPE_TEXT[settings.businessType].name.toLowerCase()}</div>
          <h1>Welcome, {membership.userName.split(" ")[0]}</h1>
        </div>
        <Link href="/" className="btn btn-glass">Go to Home</Link>
      </header>
      <section className="glass panel">
        <h2 className="title">{left === 0 ? "You are all set" : `${left} ${left === 1 ? "thing" : "things"} to get started`}</h2>
        <div className="rows">
          {steps.map((s) => (
            <div className={`row ${s.done ? "is-done" : ""}`} key={s.title}>
              <span className="tick" aria-hidden="true">{s.done ? "✓" : ""}</span>
              <div className="row-text">
                <div className="row-title">{s.title}<span className="sr-only">{s.done ? " (done)" : " (to do)"}</span></div>
                <div className="muted">{s.about}</div>
              </div>
              {!s.done && <Link href={s.href} className="btn btn-glass btn-small">{s.action}</Link>}
            </div>
          ))}
        </div>
      </section>
      <section className="glass panel">
        <h2 className="title">What is switched on</h2>
        <p className="muted">Customers, products, orders and invoices are always on. For your kind of business these are on too:</p>
        <ul className="welcome-tools">
          {on.map((f) => <li key={f}><strong>{FEATURE_TEXT[f].name}.</strong> {FEATURE_TEXT[f].about}.</li>)}
        </ul>
        {manage && <p className="muted">{FEATURES.length - on.length} more are off so they stay out of your way. Turn any of them on in <Link href="/settings" className="row-link">Settings</Link> when you need them.</p>}
      </section>
    </>
  );
}
