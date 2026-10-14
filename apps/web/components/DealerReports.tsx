import Link from "next/link";
import { commissionReport, dealerProfit, salesTaxReport, seesCost, type Ctx } from "@bos/core";
import { formatMoney } from "../lib/format";
import { todayHere, whole } from "../lib/locale";

export type DealerReportQuery = { tab?: string; from?: string; to?: string; month?: string };
type Tab = "profit" | "tax" | "commission";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const monthName = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const shiftMonth = (m: string, by: number) => {
  const d = new Date(`${m}-15T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
};
const lastDay = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const pct = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 3 })}%`;

/** Reports for a Dealer Terminal company: what each car made, the sales tax to send in, and what each salesperson earned. */
export async function DealerReports({ ctx, query }: { ctx: Ctx; query: DealerReportQuery }) {
  const costs = seesCost(ctx);
  const tabs: { key: Tab; label: string }[] = [
    ...(costs ? [{ key: "profit" as const, label: "Profit per car" }] : []),
    { key: "tax", label: "Sales tax" },
    ...(costs ? [{ key: "commission" as const, label: "Commissions" }] : []),
  ];
  const tab: Tab = tabs.some((t) => t.key === query.tab) ? (query.tab as Tab) : tabs[0]!.key;
  const today = todayHere();
  const month = query.month && /^\d{4}-\d{2}$/.test(query.month) ? query.month : today.slice(0, 7);
  const from = query.from && DATE.test(query.from) ? query.from : `${month}-01`;
  const to = query.to && DATE.test(query.to) ? query.to : query.from ? today : lastDay(month);
  const href = (change: Partial<{ tab: Tab; month: string; from: string; to: string }>) => {
    const next = { tab, month, ...change };
    const parts = [`tab=${next.tab}`, next.from ? `from=${next.from}&to=${next.to}` : `month=${next.month}`];
    return `/reports?${parts.join("&")}`;
  };

  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">Dealer Terminal</div>
          <h1>Reports</h1>
        </div>
      </header>
      <nav className="segmented rpt-tabs" aria-label="Reports">
        {tabs.map((t) => <Link key={t.key} href={href({ tab: t.key })} aria-current={t.key === tab ? "true" : undefined}>{t.label}</Link>)}
      </nav>

      <section className="glass panel">
        <form className="form-row" action="/reports">
          <input type="hidden" name="tab" value={tab} />
          {tab === "tax" ? (
            <>
              <div className="field">
                <span>Month</span>
                <div className="segmented">
                  <Link href={href({ month: shiftMonth(month, -1) })} aria-label="Month before">‹</Link>
                  <span className="seg-text">{monthName(month)}</span>
                  <Link href={href({ month: shiftMonth(month, 1) })} aria-label="Month after">›</Link>
                </div>
              </div>
            </>
          ) : (
            <>
              <label className="field"><span>From</span><input type="date" name="from" defaultValue={from} required /></label>
              <label className="field"><span>To</span><input type="date" name="to" defaultValue={to} required /></label>
              <div className="field"><span>&nbsp;</span><button type="submit" className="btn btn-glass">Show</button></div>
              <div className="field"><span>&nbsp;</span>
                <div className="segmented">
                  <Link href={href({ month: today.slice(0, 7) })}>This month</Link>
                  <Link href={href({ month: shiftMonth(today.slice(0, 7), -1) })}>Last month</Link>
                  <Link href={href({ from: `${today.slice(0, 4)}-01-01`, to: today })}>Year to date</Link>
                </div>
              </div>
            </>
          )}
        </form>
      </section>

      {tab === "profit" && <Profit ctx={ctx} from={from} to={to} />}
      {tab === "tax" && <Tax ctx={ctx} month={month} />}
      {tab === "commission" && <Commission ctx={ctx} from={from} to={to} />}
    </>
  );
}

async function Profit({ ctx, from, to }: { ctx: Ctx; from: string; to: string }) {
  const { rows, totals } = await dealerProfit(ctx, from, to);
  return (
    <>
      <div className="tiles">
        <div className="glass panel tile"><h2 className="label">Cars delivered</h2><div className="numeral">{totals.deals}</div><div className="muted">{from} to {to}</div></div>
        <div className="glass panel tile"><h2 className="label">Sales</h2><div className="numeral">{whole(totals.sales)}</div><div className="muted">Sale prices, before tax and fees</div></div>
        <div className="glass panel tile"><h2 className="label">Gross profit</h2><div className="numeral">{whole(totals.gross)}</div><div className="muted">Price and dealer fee, less each car and what was spent on it</div></div>
        <div className="glass panel tile"><h2 className="label">After commission</h2><div className="numeral">{whole(totals.net)}</div><div className="muted">{whole(totals.commission)} paid in commission</div></div>
      </div>
      <section className="glass panel">
        <div className="panel-head">
          <h2 className="title">Profit on each car</h2>
          <a className="btn btn-glass btn-small" href={`/reports/dealer-csv?report=profit&from=${from}&to=${to}`}>Download spreadsheet</a>
        </div>
        {totals.unknownCost > 0 && <p className="notice">{totals.unknownCost} {totals.unknownCost === 1 ? "car has" : "cars have"} no purchase price recorded, so {totals.unknownCost === 1 ? "its profit is" : "their profit is"} left out of the totals. Add it on the car&apos;s page.</p>}
        {rows.length === 0 ? <p className="muted">No cars delivered in these dates.</p> : (
          <div className="table-wrap">
            <table className="compact">
              <thead><tr><th>Delivered</th><th>Deal</th><th>Car</th><th>Sold by</th><th className="num">Price</th><th className="num">Dealer fee</th><th className="num">Car cost</th><th className="num">Spent on it</th><th className="num">Gross</th><th className="num">Commission</th><th className="num">Net</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.deliveredOn}</td>
                    <td><Link href={`/deals/${r.id}`} className="row-link">{r.number}</Link></td>
                    <td>{r.vehicleName || r.stockNumber}</td>
                    <td>{r.salespersonName ?? "—"}</td>
                    <td className="num">{formatMoney(r.salePrice)}</td>
                    <td className="num">{formatMoney(r.dealerFee)}</td>
                    <td className="num">{r.carCost === null ? "Not recorded" : formatMoney(r.carCost)}</td>
                    <td className="num">{formatMoney(r.costs)}</td>
                    <td className="num">{r.gross === null ? "—" : formatMoney(r.gross)}</td>
                    <td className="num">{formatMoney(r.commission)}</td>
                    <td className="num"><strong>{r.net === null ? "—" : formatMoney(r.net)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

async function Tax({ ctx, month }: { ctx: Ctx; month: string }) {
  const { rows, totals } = await salesTaxReport(ctx, month);
  return (
    <>
      <div className="tiles">
        <div className="glass panel tile"><h2 className="label">Cars delivered</h2><div className="numeral">{totals.deals}</div><div className="muted">{monthName(month)}</div></div>
        <div className="glass panel tile"><h2 className="label">Taxable sales</h2><div className="numeral">{whole(totals.taxable)}</div><div className="muted">Price and dealer fee, less trade-ins</div></div>
        <div className="glass panel tile"><h2 className="label">State sales tax</h2><div className="numeral">{formatMoney(totals.stateTax)}</div><div className="muted">6% collected</div></div>
        <div className="glass panel tile"><h2 className="label">County surtax</h2><div className="numeral">{formatMoney(totals.surtax)}</div><div className="muted">On the first $5,000 of each sale</div></div>
      </div>
      <section className="glass panel">
        <div className="panel-head">
          <div>
            <h2 className="title">By the buyer&apos;s county</h2>
            <p className="muted">Surtax on a car follows the county where the buyer lives. These are the figures kept on each deal when it was written, for the monthly sales tax return (DR-15). Check them against the return before you file.</p>
          </div>
          <a className="btn btn-glass btn-small" href={`/reports/dealer-csv?report=tax&month=${month}`}>Download spreadsheet</a>
        </div>
        {rows.length === 0 ? <p className="muted">No cars delivered in {monthName(month)}.</p> : (
          <div className="table-wrap">
            <table className="compact">
              <thead><tr><th>County</th><th className="num">Surtax rate</th><th className="num">Cars</th><th className="num">Taxable</th><th className="num">State tax</th><th className="num">Surtax base</th><th className="num">Surtax</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.county}${r.surtaxPct}`}>
                    <td>{r.county}</td><td className="num">{pct(r.surtaxPct)}</td><td className="num">{r.deals}</td><td className="num">{formatMoney(r.taxable)}</td>
                    <td className="num">{formatMoney(r.stateTax)}</td><td className="num">{formatMoney(r.surtaxBase)}</td><td className="num">{formatMoney(r.surtax)}</td>
                  </tr>
                ))}
                <tr className="row-total"><th>Total</th><td /><td className="num">{totals.deals}</td><td className="num">{formatMoney(totals.taxable)}</td><td className="num">{formatMoney(totals.stateTax)}</td><td className="num">{formatMoney(totals.surtaxBase)}</td><td className="num">{formatMoney(totals.surtax)}</td></tr>
              </tbody>
            </table>
          </div>
        )}
        {rows.some((r) => r.county === "County not recorded") && <p className="notice">Some deals have no buyer&apos;s county. Add it on those deals so the surtax goes to the right county.</p>}
      </section>
    </>
  );
}

async function Commission({ ctx, from, to }: { ctx: Ctx; from: string; to: string }) {
  const rows = await commissionReport(ctx, from, to);
  return (
    <section className="glass panel">
      <div className="panel-head">
        <div>
          <h2 className="title">Commission by salesperson</h2>
          <p className="muted">Cars delivered {from} to {to}. Set the salesperson and commission in each deal&apos;s After the sale section.</p>
        </div>
        <a className="btn btn-glass btn-small" href={`/reports/dealer-csv?report=commission&from=${from}&to=${to}`}>Download spreadsheet</a>
      </div>
      {rows.length === 0 ? <p className="muted">No cars delivered in these dates.</p> : (
        <div className="table-wrap">
          <table className="compact">
            <thead><tr><th>Salesperson</th><th className="num">Cars</th><th className="num">Sales</th><th className="num">Commission</th></tr></thead>
            <tbody>
              {rows.map((r) => <tr key={r.salespersonId ?? "none"}><td>{r.name}</td><td className="num">{r.deals}</td><td className="num">{formatMoney(r.sales)}</td><td className="num">{formatMoney(r.commission)}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
