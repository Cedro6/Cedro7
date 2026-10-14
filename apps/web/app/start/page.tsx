import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { PLANS, TRIAL_DAYS } from "@bos/core";

export const metadata: Metadata = {
  title: "Cedro Terminal and Dealer Terminal",
  description: "Two ways to run a small business without wrestling the software: Cedro Terminal for product businesses, Dealer Terminal for Florida car lots. Each with Ava, the assistant who knows your records.",
};

const CEDRO_DAY = [
  ["A customer calls", "Find them, see what they bought and what they still owe, before they finish the sentence."],
  ["Quote, confirm, pick, ship", "One order moves through the whole business. Stock is reserved when it's confirmed and counted out when it ships."],
  ["Month end", "Invoices that chase themselves, bills that say when they're due, and reports that compare any two periods."],
];
const DEALER_DAY = [
  ["A car comes in", "Type the VIN. Year, make, model, engine and trim fill themselves in; you add the price and the photos."],
  ["A buyer says yes", "Write the deal, and Florida's tax and county surtax are worked out for you. Print the 82040, 82050, 82993, the Buyers Guide and the bill of sale, filled in."],
  ["After the handshake", "Temp tag, title application, Form 8300 if the cash passed $10,000. The lot reminds you before any of it is late."],
];
const AVA = [
  "What needs me today?",
  "What's still owed on the Lopez deal?",
  "Which products are running low?",
  "Put the Civic into recon.",
];

export default function StartPage() {
  const cedro = PLANS.cedro_basic;
  const dealer = PLANS.dealer;
  return (
    <main className="landing">
      <header className="landing-top">
        <span className="landing-wordmark">Cedro</span>
        <nav className="landing-nav" aria-label="Account">
          <Link href="/sign-in">Sign in</Link>
        </nav>
      </header>

      <section className="landing-hero">
        <h1>Run the business. Not the software.</h1>
        <p>
          Two products, built by one small team, for people who would rather be selling than setting things up.
          Pick the one that sounds like your week.
        </p>
      </section>

      <section className="doors" aria-label="Products">
        <article className="door door-cedro" id="cedro">
          <div className="door-head">
            <span className="door-mark door-mark-cedro" aria-hidden="true"><i /></span>
            <h2>Cedro Terminal</h2>
          </div>
          <p className="door-for">For businesses that buy, stock and sell things: distributors, shops, warehouses, sales teams and contractors.</p>
          <dl className="door-day">
            {CEDRO_DAY.map(([when, what]) => (
              <div key={when}><dt>{when}</dt><dd>{what}</dd></div>
            ))}
          </dl>
          <ul className="door-tools" aria-label="What's inside">
            <li>Customers</li><li>Quotes and orders</li><li>Invoices and payments</li><li>Stock and counts</li><li>Purchasing</li><li>Bills</li><li>Reports</li><li>Calendar</li>
          </ul>
          <div className="door-foot">
            <p className="door-price"><strong>From ${cedro.monthly} a month.</strong> {TRIAL_DAYS.cedro} days free, no card to start.</p>
            <Link href="/sign-up?product=cedro" className="door-cta">Start Cedro Terminal free</Link>
          </div>
        </article>

        <article className="door door-dealer" id="dealer">
          <div className="door-head">
            <Image src="/brand/dealer-terminal-white.png" alt="" width={152} height={43} className="door-logo" priority />
            <h2 className="sr-only">Dealer Terminal</h2>
          </div>
          <p className="door-for">For independent used-car lots in Florida that sell for cash and hold the title. Built around the paperwork, not bolted on.</p>
          <dl className="door-day">
            {DEALER_DAY.map(([when, what]) => (
              <div key={when}><dt>{when}</dt><dd>{what}</dd></div>
            ))}
          </dl>
          <ul className="door-tools" aria-label="What's inside">
            <li>Vehicles by VIN</li><li>Deals</li><li>Florida title forms</li><li>Buyers Guide and window sticker</li><li>Form 8300</li><li>Photos and listing file</li><li>Profit and sales tax reports</li><li>Bills</li>
          </ul>
          <div className="door-foot">
            <p className="door-price"><strong>${dealer.monthly} a month</strong> for the whole lot, {dealer.includedUsers} people included. {TRIAL_DAYS.dealer} days free, no card to start.</p>
            <Link href="/sign-up?product=dealer" className="door-cta">Start Dealer Terminal free</Link>
          </div>
        </article>
      </section>

      <section className="ava-strip">
        <div className="ava-orb ava-orb-hero" aria-hidden="true" />
        <div className="ava-text">
          <h2>Both come with Ava.</h2>
          <p>
            Ava is the assistant who has read your records. Ask her a question in plain words and she answers from your own customers, orders, cars and deals, with links to the screen that proves it.
            She can get things ready for you, and nothing happens until you press Confirm. She never touches money.
          </p>
          <ul className="ava-asks" aria-label="Things people ask Ava">
            {AVA.map((q) => <li key={q}>{q}</li>)}
          </ul>
        </div>
      </section>

      <section className="straight">
        <h2>Straight answers</h2>
        <dl>
          <div><dt>Is it really free to try?</dt><dd>Yes. {TRIAL_DAYS.cedro} days for Cedro Terminal and {TRIAL_DAYS.dealer} for Dealer Terminal, with everything switched on and no card asked for. When the trial ends your records are kept; you choose a plan to carry on.</dd></div>
          <div><dt>What does it cost after that?</dt><dd>Cedro Terminal is ${PLANS.cedro_basic.monthly}, ${PLANS.cedro_small.monthly} or ${PLANS.cedro_corporate.monthly} a month depending on how many people need a login. Dealer Terminal is ${dealer.monthly} a month. Pay yearly and two months are free. Cancel from Billing whenever you like.</dd></div>
          <div><dt>Can I have both?</dt><dd>They are separate products with separate logins, so a lot and a parts business are two accounts. Most people only need one.</dd></div>
          <div><dt>Where does my data live?</dt><dd>In your own company&apos;s account, which nobody outside it can open. Every person on your team sees only what their role allows. Card payments are handled by Stripe; we never see the card number.</dd></div>
          <div><dt>Is Dealer Terminal only for Florida?</dt><dd>For now. The tax, surtax and title forms are Florida's. Other states come when enough dealers there ask.</dd></div>
        </dl>
      </section>

      <footer className="landing-foot">
        <p>Already set up? <Link href="/sign-in">Sign in</Link>.</p>
      </footer>
    </main>
  );
}
