import Link from "next/link";
import { attention, can, overview, salesTrend } from "@bos/core";
import { requireSession } from "../../lib/session";

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const shortDay = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A smooth line through the daily totals, scaled into the chart's 660 by 180 drawing area. */
function chartPoints(days: { date: string; total: number }[]) {
  const max = Math.max(...days.map((d) => d.total), 1);
  return days.map((d, i) => ({
    x: 30 + (i * 660) / Math.max(days.length - 1, 1),
    y: 220 - (d.total / max) * 170,
    ...d,
  }));
}
function chartPath(points: { x: number; y: number }[]) {
  return points
    .map((p, i) => {
      if (i === 0) return `M${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      const prev = points[i - 1]!;
      const mid = ((prev.x + p.x) / 2).toFixed(1);
      return `C${mid},${prev.y.toFixed(1)} ${mid},${p.y.toFixed(1)} ${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(" ");
}

function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default async function HomePage() {
  const { ctx, membership } = await requireSession();
  const [counts, trend, needs] = await Promise.all([overview(ctx), salesTrend(ctx), attention(ctx)]);
  const points = trend ? chartPoints(trend.days) : [];
  const path = chartPath(points);
  const peak = points.reduce<(typeof points)[number] | null>((best, p) => (p.total > 0 && (!best || p.total >= best.total) ? p : best), null);
  const change = trend && trend.lastWeek > 0 ? Math.round(((trend.thisWeek - trend.lastWeek) / trend.lastWeek) * 100) : null;
  const now = new Date();
  const zone = "America/New_York";
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: zone }).format(now));
  const today = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: zone }).format(now);
  const firstName = membership.userName.split(" ")[0];

  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">{today}</div>
          <h1>
            {greeting(hour)}, {firstName}
          </h1>
        </div>
        {can(ctx, "sales_order.write") && (
          <Link href="/sales/new" className="btn btn-primary">
            New order
          </Link>
        )}
      </header>

      <div className="tiles">
        {counts.customers !== null && (
          <Link href="/customers" className="glass panel tile">
            <h2 className="label">Customers</h2>
            <div className="numeral">{counts.customers}</div>
            <div className="muted">Active accounts</div>
          </Link>
        )}
        {counts.readyToShip !== null && (
          <Link href="/sales?show=open" className="glass panel tile">
            <h2 className="label">Ready to ship</h2>
            <div className="numeral">{counts.readyToShip}</div>
            <div className="muted">Of {counts.openOrders} open orders</div>
          </Link>
        )}
        {counts.openPurchaseOrders !== null && (
          <Link href="/purchasing?show=open" className="glass panel tile">
            <h2 className="label">Purchase orders</h2>
            <div className="numeral">{counts.openPurchaseOrders}</div>
            <div className="muted">Open with suppliers</div>
          </Link>
        )}
        {counts.lowStock !== null && (
          <Link href="/products?low=1" className="glass panel tile">
            <h2 className="label">Low stock</h2>
            <div className="numeral">{counts.lowStock}</div>
            <div className="muted">At or below reorder point</div>
          </Link>
        )}
      </div>

      <div className="split">
        {trend && (
          <section className="glass panel grow-3">
            <div className="panel-head">
              <div>
                <h2 className="label">Sales, last 7 days</h2>
                <div className="numeral-row">
                  <span className="numeral numeral-xl">{usd(trend.thisWeek)}</span>
                  {change !== null && <span className={`badge ${change >= 0 ? "badge-ok" : "badge-warn"}`}>{change >= 0 ? "+" : ""}{change}%</span>}
                </div>
                <div className="muted">
                  {trend.lastWeek > 0 ? `${usd(trend.lastWeek)} in the 7 days before` : "Orders confirmed, before tax"}
                </div>
              </div>
            </div>
            {peak ? (
              <svg viewBox="0 0 720 262" role="img" aria-label={`Daily sales over the last 21 days. Highest day ${usd(peak.total)} on ${shortDay(peak.date)}.`} className="chart">
                <defs>
                  <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#A78BFA" stopOpacity="0.55" />
                    <stop offset="1" stopColor="#A78BFA" stopOpacity="0" />
                  </linearGradient>
                  <linearGradient id="chart-line" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="#7C4DFF" />
                    <stop offset="1" stopColor="#A78BFA" />
                  </linearGradient>
                </defs>
                <path d="M30 50H690M30 135H690M30 220H690" stroke="currentColor" strokeOpacity="0.12" />
                <path d={`${path} L690,220 L30,220 Z`} fill="url(#chart-fill)" />
                <path d={path} fill="none" stroke="url(#chart-line)" strokeWidth="3.5" strokeLinecap="round" />
                <circle cx={peak.x} cy={peak.y} r="6" fill="#A78BFA" />
                <text x={Math.min(Math.max(peak.x, 80), 640)} y={Math.max(peak.y - 14, 16)} textAnchor="middle" fill="currentColor" fontSize="15" fontWeight="600">
                  {usd(peak.total)} · {shortDay(peak.date)}
                </text>
                {[0, 10, 20].map((i) => (
                  <text key={i} x={points[i]!.x} y="250" textAnchor={i === 0 ? "start" : i === 20 ? "end" : "middle"} fill="currentColor" fillOpacity="0.7" fontSize="13">
                    {shortDay(points[i]!.date)}
                  </text>
                ))}
              </svg>
            ) : (
              <p className="muted">No orders confirmed in the last three weeks. Confirm an order and it shows up here.</p>
            )}
          </section>
        )}

        <section className="glass panel grow-2">
          <h2 className="title">Needs attention</h2>
          {needs.length === 0 ? (
            <p className="muted">Nothing needs you right now.</p>
          ) : (
            <div className="rows">
              {needs.map((item) => (
                <div className="row" key={item.kind}>
                  <span className={`dot dot-${item.tone}`} aria-hidden="true" />
                  <div className="row-text">
                    <div className="row-title">{item.title}</div>
                    <div className="muted">{item.detail}</div>
                  </div>
                  <Link href={item.href} className="btn btn-glass btn-small">
                    {item.action}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
