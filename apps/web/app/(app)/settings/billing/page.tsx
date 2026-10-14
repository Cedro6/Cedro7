import Link from "next/link";
import { redirect } from "next/navigation";
import { activeMemberCount, assistantUsage, can, PLANS, plansFor, productOf, TRIAL_DAYS, TRIAL_LIMITS, yearlyPrice, type Interval } from "@bos/core";
import { billingFor, storeSubscription } from "../../../../lib/billing";
import { requireSession } from "../../../../lib/session";
import { getCheckout, stripeConfigured } from "../../../../lib/stripe";
import { choosePlan, manageBilling } from "./actions";

const day = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "");
const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string; cancelled?: string; ended?: string; yearly?: string; notice?: string; error?: string }> }) {
  const { ctx, membership } = await requireSession({ billingAllowed: true });
  const q = await searchParams;

  // Back from Stripe Checkout: read the result straight away rather than waiting for Stripe's notification.
  if (q.checkout && stripeConfigured() && can(ctx, "settings.manage")) {
    let message = "Payment received. Your plan is active.";
    try {
      const session = await getCheckout(q.checkout);
      if (session.client_reference_id === ctx.orgId && session.subscription) await storeSubscription(ctx.pool, ctx.orgId, session.subscription, new Date());
      else message = "Checkout finished. Your plan will show here within a minute.";
    } catch (error) {
      console.error("billing: could not read the checkout", error);
      message = "Checkout finished. Your plan will show here within a minute.";
    }
    redirect(`/settings/billing?notice=${encodeURIComponent(message)}`);
  }

  const manages = can(ctx, "settings.manage");
  const product = productOf(membership.businessType ?? "distributor");
  const state = billingFor(membership);
  const yearly = q.yearly === "1" || (q.yearly === undefined && state.interval === "year");
  const interval: Interval = yearly ? "year" : "month";
  const [people, usage] = await Promise.all([activeMemberCount(ctx), assistantUsage(ctx, state.avaQuestions)]);
  const current = state.plan ? PLANS[state.plan] : null;
  const plans = plansFor(product);
  const configured = stripeConfigured();

  const headline =
    state.phase === "exempt" ? (configured ? "This company is not billed" : "Billing is not switched on yet")
    : state.phase === "trial" ? `Free trial: ${state.trialDaysLeft} ${state.trialDaysLeft === 1 ? "day" : "days"} left`
    : state.phase === "active" ? `${current?.name} plan, billed ${state.interval === "year" ? "yearly" : "monthly"}`
    : state.phase === "past_due" ? "Payment failed: Stripe is retrying"
    : "Your trial or subscription has ended";
  const detail =
    state.phase === "exempt" ? (configured ? "It existed before billing began, so it has no limits and is never charged." : "Plans are shown below. Nothing is charged or limited until the Stripe keys are added.")
    : state.phase === "trial" ? `The trial ends on ${day(state.trialEndsAt)}. No card is needed until then. Choose a plan any time; days left in the trial are not charged for.`
    : state.phase === "active" ? (state.cancelAtPeriodEnd ? `Cancelled: it stays active until ${day(state.currentPeriodEnd)}, then the account locks until a plan is chosen again.` : state.status === "trialing" ? `The free trial days carry over: the first charge is on ${day(state.currentPeriodEnd)}.` : `Renews on ${day(state.currentPeriodEnd)}.`)
    : state.phase === "past_due" ? "Update the card so the plan carries on. If every retry fails, the account locks until it is paid; nothing is deleted."
    : "Your records are kept safe. Choose a plan to open them again.";

  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow"><Link href="/settings">Settings</Link> / Billing</div>
          <h1>Billing</h1>
        </div>
        {manages && state.customerId && configured && (
          <form action={manageBilling}><button type="submit" className="btn btn-glass">Card and invoices</button></form>
        )}
      </header>
      {q.error && <p className="error">{q.error}</p>}
      {q.notice && !q.error && <p className="notice">{q.notice}</p>}
      {q.cancelled && <p className="notice">Checkout was cancelled. Nothing was charged.</p>}

      <section className="glass panel">
        <h2 className="title">{headline}</h2>
        <p className="muted">{detail}</p>
        <div className="tiles">
          <div className="tile"><h3 className="label">People</h3><div className="numeral numeral-small">{people}{state.userLimit !== null ? ` of ${state.userLimit}` : ""}</div><div className="muted">{state.extraUsersBilled && current?.extraUser ? `${current.includedUsers} included, then ${usd(current.extraUser)} each a month` : state.userLimit === null ? "No limit" : "Active people on the team"}</div></div>
          <div className="tile"><h3 className="label">Ava this month</h3><div className="numeral numeral-small">{usage.questions} of {usage.limit.toLocaleString("en-US")}</div><div className="muted">Questions for the whole company; resets on the 1st</div></div>
        </div>
      </section>

      {!manages ? (
        <p className="muted">Only an owner or admin can change the plan.</p>
      ) : (
        <section className="glass panel">
          <div className="panel-head">
            <div>
              <h2 className="title">{product === "dealer" ? "Dealer Terminal plan" : "Plans"}</h2>
              <p className="muted">Prices in US dollars. Yearly billing is ten months&apos; price for twelve. {product === "dealer" ? `New dealerships get ${TRIAL_DAYS.dealer} days free.` : `New companies get ${TRIAL_DAYS.cedro} days free.`} Have a code? Enter it at checkout.</p>
            </div>
            <div className="segmented" role="group" aria-label="Billing period">
              <Link href="/settings/billing?yearly=0" aria-current={!yearly ? "true" : undefined}>Monthly</Link>
              <Link href="/settings/billing?yearly=1" aria-current={yearly ? "true" : undefined}>Yearly</Link>
            </div>
          </div>
          <div className="plan-grid">
            {plans.map((p) => {
              const isCurrent = state.plan === p.id && state.interval === interval && (state.phase === "active" || state.phase === "past_due");
              const tooSmall = p.extraUser === null && people > p.includedUsers;
              return (
                <div key={p.id} className={`glass panel plan-card ${isCurrent ? "is-current" : ""}`}>
                  <h3 className="title">{p.name}</h3>
                  <p className="muted">{p.blurb}</p>
                  <div className="plan-price">
                    <span className="numeral">{usd(yearly ? yearlyPrice(p) : p.monthly)}</span>
                    <span className="muted">{yearly ? `a year (${usd(p.monthly * 2)} off)` : "a month"}</span>
                  </div>
                  <ul className="plan-list">
                    <li>{p.includedUsers} people included{p.extraUser !== null ? `, then ${usd(p.extraUser)} each a month` : ""}</li>
                    <li>Ava: {p.avaQuestions.toLocaleString("en-US")} questions a month</li>
                    <li>{p.product === "dealer" ? "Vehicles, deals, Florida title forms, Form 8300, reports" : "Every tool switched on in Settings"}</li>
                  </ul>
                  {isCurrent ? (
                    <span className="badge badge-ok">Your plan</span>
                  ) : (
                    <form action={choosePlan.bind(null, p.id, interval)}>
                      <button type="submit" className="btn btn-primary" disabled={!configured || tooSmall} title={tooSmall ? `Your team has ${people} people; this plan includes ${p.includedUsers}` : !configured ? "Billing is not switched on yet" : ""}>
                        {state.phase === "active" || state.phase === "past_due" ? `Switch to ${p.name}` : `Choose ${p.name}`}
                      </button>
                    </form>
                  )}
                  {tooSmall && <p className="muted">Your team has {people} people; this plan includes {p.includedUsers}.</p>}
                </div>
              );
            })}
          </div>
          <p className="muted footnote plan-foot">
            {state.phase === "trial" || state.phase === "ended" ? `During the free trial a company can have up to ${TRIAL_LIMITS.users} people and ask Ava ${TRIAL_LIMITS.avaQuestions} questions. ` : ""}Card payments are taken by Stripe; this site never sees the card number.
          </p>
        </section>
      )}
    </>
  );
}
