import Link from "next/link";
import { redirect } from "next/navigation";
import { can, HISTORY_AREAS, isHistoryArea, listHistory, listMembers, type HistoryArea, type HistoryEntry } from "@bos/core";
import { zone } from "../../../../lib/locale";
import { requireSession } from "../../../../lib/session";

const AREA: Record<HistoryArea, string> = { sales: "Sales", customers: "Customers", products: "Products and stock", money: "Invoices and bills", purchasing: "Purchasing", settings: "Team and settings" };

function href(view: { area?: string; who?: string }, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (view.area) p.set("area", view.area);
  if (view.who) p.set("who", view.who);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const s = p.toString();
  return s ? `/settings/history?${s}` : "/settings/history";
}

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ area?: string; who?: string; before?: string }> }) {
  const { ctx, membership } = await requireSession();
  if (!can(ctx, "settings.manage")) redirect("/");
  const q = await searchParams;
  const area = isHistoryArea(q.area) ? q.area : undefined;
  const members = await listMembers(ctx);
  const who = members.some((m) => m.userId === q.who) ? q.who : undefined;
  const { entries, next } = await listHistory(ctx, { area, userId: who, before: q.before });
  const day = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: zone() });
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone() });
  const days: { label: string; items: HistoryEntry[] }[] = [];
  for (const e of entries) {
    const label = day.format(e.at);
    if (days.at(-1)?.label !== label) days.push({ label, items: [] });
    days.at(-1)!.items.push(e);
  }
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow"><Link href="/settings">Settings</Link> · {membership.orgName}</div>
          <h1>Activity history</h1>
        </div>
        {members.length > 1 && (
          <form action="/settings/history" className="hist-who">
            {area && <input type="hidden" name="area" value={area} />}
            <label className="field">
              <span>Person</span>
              <select name="who" defaultValue={who ?? ""}>
                <option value="">Everyone</option>
                {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
              </select>
            </label>
            <button type="submit" className="btn btn-glass btn-small">Show</button>
          </form>
        )}
      </header>
      <nav className="segmented rpt-tabs" aria-label="Kind of change">
        <Link href={href({ who })} aria-current={area ? undefined : "page"}>Everything</Link>
        {HISTORY_AREAS.map((a) => (
          <Link key={a} href={href({ area: a, who })} aria-current={a === area ? "page" : undefined}>{AREA[a]}</Link>
        ))}
      </nav>
      {entries.length === 0 ? (
        <section className="glass panel empty">
          <div className="empty-title">Nothing recorded here{q.before ? " before that" : " yet"}</div>
          <p>Every change someone makes is listed here as it happens.</p>
        </section>
      ) : (
        days.map((d) => (
          <section className="glass panel" key={d.label}>
            <h2 className="title">{d.label}</h2>
            <div className="rows">
              {d.items.map((e) => (
                <div className="row" key={e.id}>
                  <span className="hist-time muted">{time.format(e.at)}</span>
                  <div className="row-text">
                    <div>
                      <strong>{e.who}</strong> {e.what}{" "}
                      {e.subject && (e.href ? <Link href={e.href} className="row-link">{e.subject}</Link> : <strong>{e.subject}</strong>)}
                    </div>
                    {e.detail && <div className="muted">{e.detail}</div>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
      <div className="actions">
        {q.before && <Link href={href({ area, who })} className="btn btn-glass">Back to newest</Link>}
        {next && <Link href={href({ area, who }, { before: next })} className="btn btn-glass">Older</Link>}
      </div>
    </>
  );
}
