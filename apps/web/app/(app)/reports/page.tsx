import Link from "next/link";
import { can, featureOn, isReportPeriod, report, type ReportPeriod } from "@bos/core";
import { formatMoney, formatQty } from "../../../lib/format";
import { requireSession } from "../../../lib/session";

const PERIODS: { days: ReportPeriod; label: string }[] = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "12 months" },
];
const monthName = (iso: string) => new Date(`${iso}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
const whole = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** A labelled horizontal bar. The value is always printed, so the bar is never the only way to read it. */
function Bar({ label, value, max, text, tone = "accent" }: { label: React.ReactNode; value: number; max: number; text: string; tone?: "accent" | "warn" | "bad" }) {
  return (
    <div className="rep-row">
      <div className="rep-label">{label}</div>
      <div className="rep-track" aria-hidden="true">
        <div className={`rep-fill rep-${tone}`} style={{ width: `${max > 0 ? Math.max((value / max) * 100, value > 0 ? 1.5 : 0) : 0}%` }} />
      </div>
      <div className="rep-value">{text}</div>
    </div>
  );
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "report.view") || !featureOn(ctx.features, "reports")) {
    return (
      <section className="glass panel empty">
        <div className="empty-title">Reports are not available</div>
        <p>Either reports are switched off for this company or your role does not include them.</p>
      </section>
    );
  }
  const requested = Number((await searchParams).days ?? "30");
  const days = isReportPeriod(requested) ? requested : 30;
  const data = await report(ctx, days);
  const change = data.sales.previousRevenue > 0 ? Math.round(((data.sales.revenue - data.sales.previousRevenue) / data.sales.previousRevenue) * 100) : null;
  const maxMonth = Math.max(...data.byMonth.map((m) => m.revenue), 0);
  const maxProduct = Math.max(...data.topProducts.map((p) => p.revenue), 0);
  const maxCustomer = Math.max(...data.topCustomers.map((c) => c.revenue), 0);
  const owed = data.receivables;
  const maxOwed = Math.max(owed.current, owed.late30, owed.late60, owed.older);
  const showMargin = data.topProducts.some((p) => p.margin !== null);
  const label = PERIODS.find((p) => p.days === days)!.label;

  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">Last {label} · orders confirmed, before tax</div>
          <h1>Reports</h1>
        </div>
        <div className="segmented" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <Link key={p.days} href={p.days === 30 ? "/reports" : `/reports?days=${p.days}`} aria-current={p.days === days ? "true" : undefined}>
              {p.label}
            </Link>
          ))}
        </div>
      </header>

      <div className="tiles">
        <div className="glass panel tile">
          <h2 className="label">Sales</h2>
          <div className="numeral">{whole(data.sales.revenue)}</div>
          <div className="muted">
            {change === null ? "No sales in the period before" : `${change >= 0 ? "Up" : "Down"} ${Math.abs(change)}% on the ${label} before`}
          </div>
        </div>
        <div className="glass panel tile">
          <h2 className="label">Orders</h2>
          <div className="numeral">{data.sales.orders}</div>
          <div className="muted">{data.sales.orders > 0 ? `${formatMoney(data.sales.average)} average` : "None confirmed"}</div>
        </div>
        <Link href="/invoices?show=open" className="glass panel tile">
          <h2 className="label">Owed to you</h2>
          <div className="numeral">{whole(owed.total)}</div>
          <div className="muted">{owed.total - owed.current > 0 ? `${whole(owed.total - owed.current)} overdue` : "Nothing overdue"}</div>
        </Link>
        {data.stock && (
          <Link href="/products" className="glass panel tile">
            <h2 className="label">Stock value</h2>
            <div className="numeral">{whole(data.stock.value)}</div>
            <div className="muted">
              {formatQty(data.stock.units)} units at cost{data.stock.lowStock > 0 ? ` · ${data.stock.lowStock} running low` : ""}
            </div>
          </Link>
        )}
        {data.purchasing && (
          <Link href="/purchasing?show=open" className="glass panel tile">
            <h2 className="label">On order</h2>
            <div className="numeral">{whole(data.purchasing.value)}</div>
            <div className="muted">
              {data.purchasing.open} open {data.purchasing.open === 1 ? "order" : "orders"}
              {data.purchasing.late > 0 ? ` · ${data.purchasing.late} late` : ""}
            </div>
          </Link>
        )}
      </div>

      {data.sales.orders === 0 ? (
        <section className="glass panel empty">
          <div className="empty-title">No sales in the last {label}</div>
          <p>Confirm an order and it shows up here. Try a longer period above.</p>
        </section>
      ) : (
        <>
          {data.byMonth.length > 1 && (
            <section className="glass panel">
              <h2 className="title">Sales by month</h2>
              <div className="rep-bars">
                {data.byMonth.map((m) => (
                  <Bar key={m.month} label={monthName(m.month)} value={m.revenue} max={maxMonth} text={`${whole(m.revenue)} · ${m.orders} ${m.orders === 1 ? "order" : "orders"}`} />
                ))}
              </div>
            </section>
          )}
          <div className="split">
            <section className="glass panel grow-3">
              <h2 className="title">Best-selling products</h2>
              <div className="rep-bars">
                {data.topProducts.map((p) => (
                  <Bar
                    key={p.id}
                    label={<Link href={`/products/${p.id}`} className="row-link">{p.name}</Link>}
                    value={p.revenue}
                    max={maxProduct}
                    text={`${whole(p.revenue)} · ${formatQty(p.units)} sold${showMargin && p.margin !== null ? ` · ${whole(p.margin)} margin` : ""}`}
                  />
                ))}
              </div>
              {showMargin && <p className="muted footnote">Margin is sales less each product's current cost.</p>}
            </section>
            {data.topCustomers.length > 0 && (
              <section className="glass panel grow-2">
                <h2 className="title">Biggest customers</h2>
                <div className="rep-bars">
                  {data.topCustomers.map((c) => (
                    <Bar
                      key={c.id}
                      label={<Link href={`/customers/${c.id}`} className="row-link">{c.name}</Link>}
                      value={c.revenue}
                      max={maxCustomer}
                      text={`${whole(c.revenue)} · ${c.orders} ${c.orders === 1 ? "order" : "orders"}`}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        </>
      )}

      {owed.total > 0 && (
        <section className="glass panel">
          <h2 className="title">What customers owe, by age</h2>
          <div className="rep-bars">
            <Bar label="Not due yet" value={owed.current} max={maxOwed} text={whole(owed.current)} />
            <Bar label="1 to 30 days late" value={owed.late30} max={maxOwed} text={whole(owed.late30)} tone="warn" />
            <Bar label="31 to 60 days late" value={owed.late60} max={maxOwed} text={whole(owed.late60)} tone="warn" />
            <Bar label="Over 60 days late" value={owed.older} max={maxOwed} text={whole(owed.older)} tone="bad" />
          </div>
        </section>
      )}
    </>
  );
}
