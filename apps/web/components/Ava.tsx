"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { askAssistant, confirmChange, dismissChange } from "../app/(app)/assistant/actions";
import { AssistantText } from "./AssistantText";

type Change = { id: string; summary: string; state: "waiting" | "working" | "done" | "declined" | "failed"; message?: string; link?: string };
type Turn = { id: number; question: string; answer?: string; error?: string; lookups?: number; changes: Change[] };
/** What this person's role lets them do, so Ava only suggests things she can actually help with. */
export type AvaAbilities = { sales: boolean; ship: boolean; stock: boolean; reports: boolean; customers: boolean; invoices: boolean; calendar: boolean; dealer?: boolean; lot?: boolean };

type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };

const remember = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* lasts for this visit only */ }
};
const recall = (key: string) => {
  try { return localStorage.getItem(key); } catch { return null; }
};

/** The first sentence or two of a reply, as plain words, for reading aloud. Links, bold marks and lists are dropped. */
export function spokenPart(answer: string): string {
  const plain = answer
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "")
    .split("\n")
    .filter((line) => line.trim() && !/^\s*[-•]/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [plain];
  let out = "";
  for (const s of sentences) {
    if (out && (out + s).length > 280) break;
    out += s;
    if (out.length > 140) break;
  }
  return (out || plain).trim().slice(0, 380);
}

/** Things worth asking on the screen that is open, limited to what this person can do. */
function suggestionsFor(path: string, title: string, can: AvaAbilities): string[] {
  const s: (string | false)[] = [];
  if (can.dealer) {
    const record = /^\/[a-z]+\/[0-9a-f]{8}-/.test(path);
    if (path.startsWith("/vehicles/") && record) s.push("What does this car still need before it can be sold?", "Write a short listing description for this car", Boolean(can.lot) && "Put this car on the lot", can.calendar && "Remind me to follow up on this car on Friday");
    else if (path.startsWith("/vehicles")) s.push("What has been on the lot longest?", "Which cars have no asking price or title number?", "Find me a truck under 100,000 miles");
    else if (path.startsWith("/deals/") && record) s.push("What is still owed on this deal?", "What do the title forms still need?", "Draft a text telling the buyer their car is ready");
    else if (path.startsWith("/deals")) s.push("Which deals still have money owed?", "Which deals are ready to deliver?", "How many cars did we sell this month?");
    else if (path.startsWith("/customers/") && record) s.push(`Has ${title} bought from us before?`, can.calendar && `Remind me to call ${title} next week`);
    else s.push("What needs my attention on the lot today?", "Which deals still have money owed?", "What has been on the lot longest?", "How many cars did we sell this month?");
    return s.filter((x): x is string => Boolean(x)).slice(0, 4);
  }
  const record = /^\/[a-z]+\/[0-9a-f-]{36}/.test(path);
  if (path.startsWith("/customers/") && record) s.push(`What does ${title} owe us?`, can.sales && `Make a quote for ${title}`, can.calendar && `Remind me to call ${title} next week`, "Draft an email asking how their last order went");
  else if (path.startsWith("/customers")) s.push("Which customers have gone quiet?", can.invoices && "Who owes us the most?", can.customers && "Add a new customer");
  else if (path.startsWith("/sales/") && record) s.push("Summarise this order", can.ship && "Ship this order", can.sales && "Is anything on this order out of stock?");
  else if (path.startsWith("/sales")) s.push(can.ship && "What is ready to ship?", "Which quotes are still open?", can.sales && "Confirm the oldest quote");
  else if (path.startsWith("/invoices/") && record) s.push("Draft a polite email chasing this invoice", can.calendar && "Remind me to follow up on this in 3 days");
  else if (path.startsWith("/invoices")) s.push("Who owes us money, and how late is it?", "Draft chasing emails for the overdue invoices");
  else if (path.startsWith("/products/") && record) s.push("How has this product sold in the last 90 days?", can.stock && "Should I reorder this?");
  else if (path.startsWith("/products") || path.startsWith("/warehouse")) s.push(can.stock && "What is running low?", can.stock && "What has not sold in the last 90 days?");
  else if (path.startsWith("/reports")) s.push(can.reports && "How did this month compare with last month?", can.reports && "What is driving the change in sales?", can.reports && "Which customers are new this quarter?");
  else if (path.startsWith("/bills")) s.push("What bills are due this week?", "How much do we owe in total?");
  else if (path.startsWith("/purchasing")) s.push(can.stock && "What should I reorder, and from whom?", "Which deliveries are late?");
  else if (path.startsWith("/calendar")) s.push("What have I got on this week?", can.calendar && "Remind me tomorrow to check the overdue invoices");
  else s.push("What needs my attention today?", can.invoices && "Who owes us money, and how late is it?", can.stock && "What should I reorder?", can.reports && "How were sales in the last 30 days?");
  return s.filter((x): x is string => Boolean(x)).slice(0, 4);
}

export function Ava({ firstName, on, left, limit, voice, abilities, due }: {
  /** Reminders for this person due today or overdue. */
  due: number;
  firstName: string; on: boolean; left: number; limit: number;
  /** True when Ava's own voice is set up. Without it she stays silent and says why. */
  voice: boolean; abilities: AvaAbilities;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const [remaining, setRemaining] = useState(left);
  const [aloud, setAloud] = useState(false);
  const [voiceNote, setVoiceNote] = useState("");
  const [listening, setListening] = useState(false);
  const [canListen, setCanListen] = useState(false);
  const [title, setTitle] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const audio = useRef<HTMLAudioElement | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const disabled = !on || remaining <= 0;

  useEffect(() => {
    setOpen(recall("ava-open") === "1" || params.get("ava") === "open");
    setAloud(recall("ava-aloud") === "1");
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    setCanListen(Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition));
    // Run once on arrival; the address is only read to honour a link that asks for Ava to be open.
  }, []);
  // The heading of the screen that is open tells Ava what "this" means.
  useEffect(() => {
    const timer = setTimeout(() => setTitle(document.querySelector("main h1")?.textContent?.trim() ?? ""), 60);
    return () => clearTimeout(timer);
  }, [pathname]);
  // Other parts of the screen (the briefing on Home) can ask for Ava to be opened.
  useEffect(() => {
    const opener = () => { setOpen(true); remember("ava-open", "1"); setTimeout(() => box.current?.focus(), 50); };
    window.addEventListener("ava:open", opener);
    return () => window.removeEventListener("ava:open", opener);
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [turns, pending, open]);

  const show = (next: boolean) => {
    setOpen(next);
    remember("ava-open", next ? "1" : "0");
    if (next) setTimeout(() => box.current?.focus(), 50);
    else quiet();
  };
  const quiet = () => {
    audio.current?.pause();
    audio.current = null;
  };

  const say = useCallback(async (answer: string) => {
    const text = spokenPart(answer);
    if (!text) return;
    quiet();
    setVoiceNote("");
    try {
      const response = await fetch("/ava/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (response.status !== 200) {
        const told = (await response.json().catch(() => null)) as { problem?: string } | null;
        setVoiceNote(told?.problem ?? "Ava could not speak just now.");
        return;
      }
      const player = new Audio(URL.createObjectURL(await response.blob()));
      audio.current = player;
      await player.play();
    } catch {
      setVoiceNote("Ava could not speak just now. Your browser may be blocking sound on this site.");
    }
  }, []);

  const patch = (turnId: number, changeId: string, update: Partial<Change>) =>
    setTurns((now) => now.map((t) => (t.id === turnId ? { ...t, changes: t.changes.map((c) => (c.id === changeId ? { ...c, ...update } : c)) } : t)));

  async function send(question: string) {
    const asked = question.trim();
    if (!asked || pending || disabled) return;
    const id = nextId.current++;
    // What was said so far, as plain text. A change that was made or dropped is noted so Ava knows.
    const history = turns.filter((t) => t.answer).flatMap((t) => [
      { role: "user" as const, text: t.question },
      { role: "assistant" as const, text: [t.answer!, ...t.changes.map((c) => (c.state === "done" ? `(The person confirmed: ${c.summary} Result: ${c.message})` : c.state === "declined" ? `(The person declined: ${c.summary})` : `(Still waiting for the person to confirm: ${c.summary})`))].join("\n") },
    ]);
    setTurns((now) => [...now, { id, question: asked, changes: [] }]);
    setPending(true);
    if (box.current) box.current.value = "";
    quiet();
    try {
      const result = await askAssistant(asked, history, { path: pathname, title });
      setTurns((now) => now.map((t) => (t.id === id ? { ...t, answer: result.answer, error: result.error, lookups: result.lookups, changes: result.proposals.map((p) => ({ ...p, state: "waiting" as const })) } : t)));
      if (!result.error) setRemaining((n) => Math.max(n - 1, 0));
      if (aloud && voice && result.answer) void say(result.answer);
    } catch {
      setTurns((now) => now.map((t) => (t.id === id ? { ...t, error: "I could not be reached. Check your connection and try again." } : t)));
    } finally {
      setPending(false);
      box.current?.focus();
    }
  }

  async function confirm(turnId: number, change: Change) {
    patch(turnId, change.id, { state: "working" });
    try {
      const result = await confirmChange(change.id);
      patch(turnId, change.id, result.ok ? { state: "done", message: result.message, link: result.link } : { state: "failed", message: result.message });
    } catch {
      patch(turnId, change.id, { state: "failed", message: "That could not be done just now. Nothing was changed." });
    }
  }
  // One job, one OK: the waiting steps run in order, stopping at the first that fails.
  async function confirmAll(turnId: number) {
    const turn = turns.find((t) => t.id === turnId);
    for (const change of turn?.changes.filter((c) => c.state === "waiting") ?? []) {
      patch(turnId, change.id, { state: "working" });
      try {
        const result = await confirmChange(change.id);
        patch(turnId, change.id, result.ok ? { state: "done", message: result.message, link: result.link } : { state: "failed", message: result.message });
        if (!result.ok) break;
      } catch {
        patch(turnId, change.id, { state: "failed", message: "That could not be done just now. Nothing was changed." });
        break;
      }
    }
  }
  async function decline(turnId: number, change: Change) {
    patch(turnId, change.id, { state: "declined" });
    try { await dismissChange(change.id); } catch { /* it simply expires if this does not reach the server */ }
  }

  function listen() {
    if (listening) { recognition.current?.stop(); return; }
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const Maker = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Maker) return;
    const r = new Maker();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = false;
    let heard = "";
    r.onresult = (e) => {
      heard = Array.from(e.results).map((x) => x[0]!.transcript).join(" ");
      if (box.current) box.current.value = heard;
    };
    r.onerror = () => setListening(false);
    r.onend = () => {
      setListening(false);
      if (heard.trim()) void send(heard);
    };
    recognition.current = r;
    quiet();
    setListening(true);
    try { r.start(); } catch { setListening(false); }
  }

  if (!open) {
    return (
      <button type="button" className="ava-launch" onClick={() => show(true)} aria-label="Open Ava, your assistant">
        <span className="ava-orb" aria-hidden="true" />
        <span className="ava-launch-name">Ava</span>
        {due > 0 && <span className="ava-nudge" aria-label={`${due} ${due === 1 ? "reminder is" : "reminders are"} due`}>{due > 9 ? "9+" : due}</span>}
      </button>
    );
  }

  const ideas = [...(due > 0 && abilities.calendar ? ["What is due today?"] : []), ...suggestionsFor(pathname, title, abilities)].slice(0, 4);
  return (
    <aside id="assistant" className="glass" aria-label="Ava, your assistant">
      <div className="as-head">
        <div className="as-title"><span className="ava-orb ava-orb-small" aria-hidden="true" /><span>Ava</span></div>
        <div className="as-head-actions">
          <button type="button" className="link-button" aria-pressed={aloud} onClick={() => { const next = !aloud; setAloud(next); remember("ava-aloud", next ? "1" : "0"); if (!next) quiet(); }}>
            {aloud ? "Voice on" : "Voice off"}
          </button>
          {turns.length > 0 && <button type="button" className="link-button" onClick={() => { setTurns([]); quiet(); }}>New chat</button>}
          <button type="button" className="ava-close" onClick={() => show(false)} aria-label="Close Ava">×</button>
        </div>
      </div>

      <div className="as-list" aria-live="polite">
        {turns.length === 0 && (
          <div className="as-empty">
            <span className="ava-orb ava-orb-big" aria-hidden="true" />
            <h3>Hi {firstName}, I&apos;m Ava.</h3>
            {!on ? (
              <p className="muted">I have not been switched on for this site yet. Once an AI key is added to the site&apos;s settings, I can help from here.</p>
            ) : remaining <= 0 ? (
              <p className="muted">Your company has used all {limit} of this month&apos;s questions. I&apos;ll be back on the 1st.</p>
            ) : (
              <>
                <p className="muted">I can find things, keep track, and prepare the paperwork for you to confirm. Ask me, or tell me what to do.</p>
                {due > 0 && <p className="ava-due">{due === 1 ? "You have a reminder due today." : `You have ${due} reminders due today or overdue.`}</p>}
                <div className="as-suggestions">
                  {ideas.map((q) => (
                    <button key={q} type="button" className="as-suggestion" onClick={() => void send(q)} disabled={pending}>{q}</button>
                  ))}
                </div>
                <p className="muted as-fine">Nothing changes until you press Confirm. I never take payments, pay bills, give refunds, raise purchase orders or set prices. I can be wrong, so check before acting.</p>
              </>
            )}
          </div>
        )}
        {turns.map((turn) => (
          <div key={turn.id} className="ava-turn">
            <div className="as-msg as-user"><div className="as-bubble">{turn.question}</div></div>
            <div className="as-msg as-bot">
              {turn.error && <p className="error">{turn.error}</p>}
              {turn.answer && <div className="as-text"><AssistantText text={turn.answer} /></div>}
              {turn.changes.filter((c) => c.state === "waiting").length > 1 && (
                <div className="ava-all">
                  <span className="muted">{turn.changes.filter((c) => c.state === "waiting").length} steps waiting for your OK.</span>
                  <button type="button" className="btn btn-primary btn-small" onClick={() => void confirmAll(turn.id)}>Confirm all</button>
                </div>
              )}
              {turn.changes.map((change) => (
                <div key={change.id} className={`as-approval is-${change.state === "working" ? "waiting" : change.state}`}>
                  <div className="as-approval-label">{change.state === "done" ? "Done" : change.state === "declined" ? "Not done" : change.state === "failed" ? "Could not be done" : "Needs your OK"}</div>
                  <div>{change.summary}</div>
                  {change.state === "failed" && <div className="as-approval-result">{change.message}</div>}
                  {change.state === "done" && (
                    <div className="as-approval-result">
                      {change.message} {change.link && <Link href={change.link} className="row-link">Open it</Link>}
                    </div>
                  )}
                  {(change.state === "waiting" || change.state === "working" || change.state === "failed") && (
                    <div className="as-card-actions">
                      <button type="button" className="btn btn-primary btn-small" disabled={change.state === "working"} onClick={() => confirm(turn.id, change)}>{change.state === "working" ? "Working…" : change.state === "failed" ? "Try again" : "Confirm"}</button>
                      <button type="button" className="btn btn-glass btn-small" disabled={change.state === "working"} onClick={() => decline(turn.id, change)}>Don&apos;t do it</button>
                    </div>
                  )}
                </div>
              ))}
              {turn.answer && (
                <div className="ava-foot">
                  {turn.lookups ? <span className="muted">From {turn.lookups} {turn.lookups === 1 ? "lookup" : "lookups"} of your records.</span> : null}
                  <button type="button" className="link-button" onClick={() => void say(turn.answer!)}>Read aloud</button>
                </div>
              )}
            </div>
          </div>
        ))}
        {pending && <div className="as-msg as-bot"><span className="as-thinking"><i /><i /><i /><span className="sr-only">Ava is looking</span></span></div>}
        <div ref={end} />
      </div>

      {voiceNote && <p className="ava-voice-note" role="status">{voiceNote}</p>}
      <form className="as-form" onSubmit={(event) => { event.preventDefault(); void send(box.current?.value ?? ""); }}>
        <label className="sr-only" htmlFor="ava-input">Message Ava</label>
        <textarea
          id="ava-input" ref={box} rows={1} maxLength={1000} disabled={disabled}
          placeholder={disabled ? "Ava is not available" : listening ? "Listening…" : "Ask, or tell me what to do"}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(event.currentTarget.value); } }}
        />
        {canListen && (
          <button type="button" className={`as-send ava-mic ${listening ? "is-live" : ""}`} onClick={listen} disabled={disabled || pending} aria-pressed={listening} aria-label={listening ? "Stop listening" : "Speak to Ava"}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          </button>
        )}
        <button type="submit" className="as-send" disabled={disabled || pending} aria-label="Send">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        </button>
      </form>
      {on && <div className="ava-left muted">{remaining} of {limit} questions left this month</div>}
    </aside>
  );
}
