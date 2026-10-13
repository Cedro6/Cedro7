/** Small chart pieces for the Home cards. All plain SVG and CSS, drawn on the server. */

export function smoothPath(points: [number, number][]): string {
  return points
    .map(([x, y], i) => {
      if (i === 0) return `M${x.toFixed(1)},${y.toFixed(1)}`;
      const [px, py] = points[i - 1]!;
      const mid = ((px + x) / 2).toFixed(1);
      return `C${mid},${py.toFixed(1)} ${mid},${y.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function niceMax(value: number): number {
  if (value <= 0) return 100;
  const power = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (value <= step * power) return step * power;
  return 10 * power;
}
const shortMoney = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `$${Math.round(n)}`);
const shortDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A smooth area chart of a daily series, plotted to one scale with labelled gridlines. */
export function AreaChart({ series, label, animate }: { series: { date: string; total: number }[]; label: string; animate?: string }) {
  const W = 720, H = 250, left = 46, right = 16, top = 26, bottom = 30;
  const max = niceMax(Math.max(...series.map((d) => d.total)));
  const x = (i: number) => left + (i * (W - left - right)) / Math.max(1, series.length - 1);
  const y = (v: number) => top + (1 - v / max) * (H - top - bottom);
  const points = series.map((d, i): [number, number] => [x(i), y(d.total)]);
  const line = smoothPath(points);
  const [lx, ly] = points.at(-1)!;
  const every = Math.ceil(series.length / 6);
  return (
    <svg key={animate} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className={animate ? "chart chart-animated" : "chart"}>
      <defs>
        <linearGradient id="home-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#A78BFA" stopOpacity="0.5" />
          <stop offset="1" stopColor="#A78BFA" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="home-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#7C4DFF" />
          <stop offset="1" stopColor="#A78BFA" />
        </linearGradient>
      </defs>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <path d={`M${left} ${y(f * max).toFixed(1)}H${W - right}`} stroke="currentColor" strokeOpacity="0.12" fill="none" />
          <text x={left - 8} y={y(f * max) + 4} fill="currentColor" fillOpacity="0.7" fontSize="12" textAnchor="end">
            {shortMoney(f * max)}
          </text>
        </g>
      ))}
      <path d={`${line} L${lx.toFixed(1)},${y(0).toFixed(1)} L${left},${y(0).toFixed(1)} Z`} fill="url(#home-area)" className="chart-area" />
      <path d={line} pathLength={1} fill="none" stroke="url(#home-line)" strokeWidth="3" strokeLinecap="round" className="chart-line" />
      <circle cx={lx} cy={ly} r="5" fill="#A78BFA" className="chart-dot" />
      {series.map((d, i) =>
        i % every === 0 && i < series.length - every / 2 ? (
          <text key={d.date} x={x(i)} y={H - 8} fill="currentColor" fillOpacity="0.7" fontSize="12" textAnchor="middle">
            {shortDay(d.date)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

export function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  const points = values.map((v, i): [number, number] => [2 + (i * 96) / Math.max(1, values.length - 1), 30 - (v / max) * 26]);
  return (
    <svg className="sparkline" viewBox="0 0 100 34" width="100" height="34" aria-hidden="true">
      <path d={smoothPath(points)} fill="none" stroke="#A78BFA" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Horizontal bars, all drawn against the largest value. The figure is always printed. */
export function BarList({ items }: { items: { key: string; label: React.ReactNode; sub?: string; value: number; text: string }[] }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="bars">
      {items.map((item) => (
        <div className="bar-row" key={item.key}>
          <div className="bar-label">
            {item.label}
            {item.sub && <span className="muted"> {item.sub}</span>}
          </div>
          <div className="bar-track">
            <span style={{ width: `${Math.max(1.5, (item.value / max) * 100).toFixed(1)}%` }} />
          </div>
          <div className="bar-value">{item.text}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Two lines on one scale: the chosen dates solid, the comparison dates dashed, lined up step for step.
 * The dashed line is also named in the legend under the chart, so it never depends on colour alone.
 */
export function CompareChart({ steps, label, animate, tick }: {
  steps: { start: string; now: number; was: number | null }[]; label: string; animate?: string; tick: (iso: string) => string;
}) {
  const W = 720, H = 260, left = 46, right = 16, top = 20, bottom = 30;
  const compared = steps.some((s) => s.was !== null);
  const max = niceMax(Math.max(...steps.map((s) => Math.max(s.now, s.was ?? 0))));
  const x = (i: number) => (steps.length === 1 ? (left + W - right) / 2 : left + (i * (W - left - right)) / (steps.length - 1));
  const y = (v: number) => top + (1 - v / max) * (H - top - bottom);
  const now = steps.map((s, i): [number, number] => [x(i), y(s.now)]);
  const was = steps.flatMap((s, i): [number, number][] => (s.was === null ? [] : [[x(i), y(s.was)]]));
  const line = smoothPath(now);
  const [lx, ly] = now.at(-1)!;
  const [fx] = now[0]!;
  const every = Math.ceil(steps.length / 6);
  return (
    <svg key={animate} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className={animate ? "chart chart-animated" : "chart"}>
      <defs>
        <linearGradient id="rpt-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#A78BFA" stopOpacity="0.4" />
          <stop offset="1" stopColor="#A78BFA" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <path d={`M${left} ${y(f * max).toFixed(1)}H${W - right}`} stroke="currentColor" strokeOpacity="0.12" fill="none" />
          <text x={left - 8} y={y(f * max) + 4} fill="currentColor" fillOpacity="0.7" fontSize="12" textAnchor="end">
            {shortMoney(f * max)}
          </text>
        </g>
      ))}
      <path d={`${line} L${lx.toFixed(1)},${y(0).toFixed(1)} L${fx.toFixed(1)},${y(0).toFixed(1)} Z`} fill="url(#rpt-area)" className="chart-area" />
      {compared && was.length > 0 && (
        <path d={smoothPath(was)} fill="none" stroke="currentColor" strokeOpacity="0.55" strokeWidth="2" strokeDasharray="5 6" strokeLinecap="round" className="chart-was" />
      )}
      <path d={line} pathLength={1} fill="none" stroke="#A78BFA" strokeWidth="3" strokeLinecap="round" className="chart-line" />
      <circle cx={lx} cy={ly} r="5" fill="#A78BFA" className="chart-dot" />
      {steps.map((s, i) =>
        i % every === 0 && (i < steps.length - every / 2 || steps.length <= 6) ? (
          <text key={s.start} x={x(i)} y={H - 8} fill="currentColor" fillOpacity="0.7" fontSize="12" textAnchor="middle">
            {tick(s.start)}
          </text>
        ) : null,
      )}
    </svg>
  );
}
