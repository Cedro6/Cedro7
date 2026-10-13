import Link from "next/link";
import { calendarEntries, featureOn, listReminders, listTeam, type CalendarEntry } from "@bos/core";
import { ReminderList } from "../../../components/ReminderList";
import { requireSession } from "../../../lib/session";
import { todayHere } from "../../../lib/locale";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (value: string) => new Date(`${value}T12:00:00Z`);
const addDays = (value: string, n: number) => iso(new Date(utc(value).getTime() + n * 86_400_000));
const TONE: Record<CalendarEntry["kind"], string> = { reminder: "info", delivery: "ok", invoice_due: "warn" };
const KIND: Record<CalendarEntry["kind"], string> = { reminder: "Reminder", delivery: "Delivery expected", invoice_due: "Invoice due" };

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ month?: string; day?: string; error?: string; notice?: string }> }) {
  const { ctx } = await requireSession();
  if (!featureOn(ctx.features, "calendar")) {
    return (
      <section className="glass panel empty">
        <div className="empty-title">The calendar is switched off</div>
        <p>An owner can switch it on in Settings.</p>
      </section>
    );
  }
  const params = await searchParams;
  const today = todayHere();
  const day = params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day) && !Number.isNaN(utc(params.day).getTime()) ? params.day : null;
  const month = params.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(params.month) ? params.month : (day ?? today).slice(0, 7);
  const first = `${month}-01`;
  const gridStart = addDays(first, -utc(first).getUTCDay());
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const shown = days.slice(0, days[35]!.slice(0, 7) === month ? 42 : 35);
  const shift = (n: number) => iso(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + n, 1))).slice(0, 7);
  const selected = day ?? (today.slice(0, 7) === month ? today : first);

  const [entries, open, team] = await Promise.all([calendarEntries(ctx, shown[0]!, shown.at(-1)!), listReminders(ctx, { openOnly: true }), listTeam(ctx)]);
  const byDay = new Map<string, CalendarEntry[]>();
  for (const entry of entries) byDay.set(entry.date, [...(byDay.get(entry.date) ?? []), entry]);
  const onDay = byDay.get(selected) ?? [];
  const others = onDay.filter((e) => e.kind !== "reminder");
  const dayReminders = (await listReminders(ctx, { from: selected, to: selected }));
  const overdue = open.filter((r) => r.overdue);
  const back = `/calendar?month=${month}&day=${selected}`;
  const title = utc(first).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const selectedTitle = utc(selected).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">{open.length} open {open.length === 1 ? "reminder" : "reminders"}{overdue.length > 0 ? ` · ${overdue.length} overdue` : ""}</div>
          <h1>Calendar</h1>
        </div>
        <div className="cal-nav">
          <Link href={`/calendar?month=${shift(-1)}`} className="btn btn-glass btn-small" aria-label="Previous month">
            ‹
          </Link>
          <div className="cal-month">{title}</div>
          <Link href={`/calendar?month=${shift(1)}`} className="btn btn-glass btn-small" aria-label="Next month">
            ›
          </Link>
          <Link href="/calendar" className="btn btn-glass btn-small">
            Today
          </Link>
        </div>
      </header>
      {params.error && <p className="error">{params.error}</p>}
      {params.notice && !params.error && <p className="notice">{params.notice}</p>}

      <div className="split">
        <section className="glass panel cal-panel grow-3">
          <div className="cal-grid cal-weekdays" aria-hidden="true">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
          <div className="cal-grid">
            {shown.map((date) => {
              const items = byDay.get(date) ?? [];
              const label = utc(date).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
              return (
                <Link
                  key={date}
                  href={`/calendar?month=${month}&day=${date}`}
                  className={`cal-cell ${date.slice(0, 7) === month ? "" : "is-outside"} ${date === today ? "is-today" : ""}`}
                  aria-current={date === selected ? "date" : undefined}
                  aria-label={`${label}${items.length ? `, ${items.length} ${items.length === 1 ? "item" : "items"}` : ""}`}
                >
                  <span className="cal-num">{Number(date.slice(8))}</span>
                  <span className="cal-entries">
                    {items.slice(0, 2).map((item, i) => (
                      <span className={`cal-chip ${item.done ? "is-done" : ""}`} key={i}>
                        <span className={`dot dot-${TONE[item.kind]}`} aria-hidden="true" />
                        <span>{item.title}</span>
                      </span>
                    ))}
                    {items.length > 2 && <span className="cal-more">+{items.length - 2} more</span>}
                  </span>
                </Link>
              );
            })}
          </div>
          <div className="cal-legend">
            <span className="dot dot-info" aria-hidden="true" /> Reminder &nbsp; <span className="dot dot-ok" aria-hidden="true" /> Delivery expected &nbsp;{" "}
            <span className="dot dot-warn" aria-hidden="true" /> Invoice due
          </div>
        </section>

        <div className="stack-panels grow-2">
          <section className="glass panel">
            <h2 className="title">{selected === today ? "Today" : selectedTitle}</h2>
            {others.length > 0 && (
              <div className="rows">
                {others.map((item, i) => (
                  <div className={`row ${item.done ? "is-done" : ""}`} key={i}>
                    <span className={`dot dot-${TONE[item.kind]}`} aria-hidden="true" />
                    <div className="row-text">
                      <Link href={item.href} className="row-link">
                        {item.title}
                      </Link>
                      <div className="muted">{KIND[item.kind]}{item.done ? (item.kind === "delivery" ? " · received" : " · paid") : ""}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <ReminderList reminders={dayReminders} team={team} back={back} defaultDate={selected} me={ctx.userId} empty={others.length ? "No reminders on this day." : "Nothing on this day."} />
          </section>
          {overdue.length > 0 && (
            <section className="glass panel">
              <h2 className="title">Overdue</h2>
              <div className="rows">
                {overdue.map((r) => (
                  <div className="row" key={r.id}>
                    <div className="row-text">
                      <Link href={`/calendar?month=${r.dueOn.slice(0, 7)}&day=${r.dueOn}`} className="row-link">
                        {r.title}
                      </Link>
                      <div className="muted">{[utc(r.dueOn).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }), r.customerName].filter(Boolean).join(" · ")}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
