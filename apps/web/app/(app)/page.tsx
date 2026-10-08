import Link from "next/link";
import { overview } from "@bos/core";
import { SparkIcon } from "../../components/icons";
import { sampleBriefing, sampleSales } from "../../lib/sample";
import { requireSession } from "../../lib/session";

function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default async function HomePage() {
  const { ctx, membership } = await requireSession();
  const counts = await overview(ctx);
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
        {counts.customers !== null && (
          <Link href="/customers/new" className="btn btn-primary">
            New customer
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
        {counts.products !== null && (
          <Link href="/products" className="glass panel tile">
            <h2 className="label">Products</h2>
            <div className="numeral">{counts.products}</div>
            <div className="muted">In the catalog</div>
          </Link>
        )}
        <div className="glass panel tile">
          <h2 className="label">Team</h2>
          <div className="numeral">{counts.team}</div>
          <div className="muted">People with access</div>
        </div>
      </div>

      <div className="split">
        <section className="glass panel grow-3">
          <div className="panel-head">
            <div>
              <h2 className="label">Sales this week</h2>
              <div className="numeral-row">
                <span className="numeral numeral-xl">{sampleSales.total}</span>
                <span className="badge badge-ok">{sampleSales.change}</span>
              </div>
              <div className="muted">{sampleSales.note}</div>
            </div>
            <span className="badge badge-sample">Sample data · sales arrives in stage 5</span>
          </div>
          <svg viewBox="0 0 720 262" role="img" aria-label="Sample chart of daily sales over three weeks" className="chart">
            <defs>
              <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#E6D3B3" stopOpacity="0.55" />
                <stop offset="1" stopColor="#E6D3B3" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="chart-line" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#A9BC9A" />
                <stop offset="0.55" stopColor="#E6D3B3" />
                <stop offset="1" stopColor="#FFFFFF" />
              </linearGradient>
              <filter id="chart-glow" x="-10%" y="-40%" width="120%" height="180%">
                <feGaussianBlur stdDeviation="9" />
              </filter>
            </defs>
            <path d="M30 60H690M30 140H690M30 220H690" stroke="#FFFFFF" strokeOpacity="0.1" />
            <path d={`${sampleSales.path} L690,232 L30,232 Z`} fill="url(#chart-fill)" />
            <path d={sampleSales.path} fill="none" stroke="url(#chart-line)" strokeWidth="8" strokeLinecap="round" opacity="0.7" filter="url(#chart-glow)" />
            <path d={sampleSales.path} fill="none" stroke="url(#chart-line)" strokeWidth="3.5" strokeLinecap="round" />
            <circle cx="690" cy="51" r="13" fill="#FFFFFF" fillOpacity="0.28" />
            <circle cx="690" cy="51" r="6" fill="#FFFFFF" />
            <text x="676" y="28" textAnchor="end" fill="#FFFFFF" fontSize="15" fontWeight="600">
              {sampleSales.peak}
            </text>
            {sampleSales.labels.map((label, index) => (
              <text key={label} x={30 + index * 300} y="256" fill="#C9D0DB" fontSize="13">
                {label}
              </text>
            ))}
          </svg>
        </section>

        <section className="glass panel grow-2">
          <div className="briefing-head">
            <span className="spark" aria-hidden="true">
              <SparkIcon />
            </span>
            <div>
              <h2 className="title">Your briefing</h2>
              <div className="muted">The assistant arrives in phase 2</div>
            </div>
          </div>
          <span className="badge badge-sample">Sample data</span>
          <div className="rows">
            {sampleBriefing.map((item) => (
              <div className="row" key={item.title}>
                <span className={`dot dot-${item.tone}`} aria-hidden="true" />
                <div className="row-text">
                  <div className="row-title">{item.title}</div>
                  <div className="muted">{item.detail}</div>
                </div>
                <button type="button" className="btn btn-glass btn-small" disabled>
                  {item.action}
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
