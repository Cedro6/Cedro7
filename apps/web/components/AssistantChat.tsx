"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { askAssistant, confirmChange, dismissChange } from "../app/(app)/assistant/actions";

type Change = { id: string; summary: string; state: "waiting" | "working" | "done" | "dismissed" | "failed"; message?: string; link?: string };
type Turn = { id: number; question: string; answer?: string; error?: string; lookups?: number; changes: Change[] };

/** Turns [label](/path) into links to screens in this app, and **bold** into bold. Anything else stays plain text. */
function rich(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\[([^\]\n]{1,120})\]\((\/[A-Za-z0-9/_?=&%.-]{0,200})\)|\*\*([^*\n]{1,200})\*\*/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > last) parts.push(line.slice(last, match.index));
    if (match[1] !== undefined && match[2] !== undefined && !match[2].startsWith("//")) {
      parts.push(
        <Link key={match.index} href={match[2]} className="row-link">
          {match[1]}
        </Link>,
      );
    } else if (match[3] !== undefined) {
      parts.push(<strong key={match.index}>{match[3]}</strong>);
    } else {
      parts.push(match[0]);
    }
    last = match.index + match[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

function Answer({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index}>
          {paragraph.split("\n").map((line, i) => (
            <span key={i} className="assistant-line">
              {rich(line.replace(/^\s*[-*•]\s+/, "• ").replace(/^#+\s*/, ""))}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

export function AssistantChat({ suggestions, disabled }: { suggestions: string[]; disabled: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [turns, pending]);

  const patch = (turnId: number, changeId: string, update: Partial<Change>) =>
    setTurns((now) => now.map((t) => (t.id === turnId ? { ...t, changes: t.changes.map((c) => (c.id === changeId ? { ...c, ...update } : c)) } : t)));

  async function send(question: string) {
    const asked = question.trim();
    if (!asked || pending || disabled) return;
    const id = nextId.current++;
    // What was said so far, as plain text. A change that was made or dropped is noted so the assistant knows.
    const history = turns
      .filter((t) => t.answer)
      .flatMap((t) => [
        { role: "user" as const, text: t.question },
        {
          role: "assistant" as const,
          text: [t.answer!, ...t.changes.map((c) => (c.state === "done" ? `(The person confirmed: ${c.summary} Result: ${c.message})` : c.state === "dismissed" ? `(The person declined: ${c.summary})` : `(Still waiting for the person to confirm: ${c.summary})`))].join("\n"),
        },
      ]);
    setTurns((now) => [...now, { id, question: asked, changes: [] }]);
    setPending(true);
    if (box.current) box.current.value = "";
    try {
      const result = await askAssistant(asked, history);
      setTurns((now) =>
        now.map((t) => (t.id === id ? { ...t, answer: result.answer, error: result.error, lookups: result.lookups, changes: result.proposals.map((p) => ({ ...p, state: "waiting" as const })) } : t)),
      );
    } catch {
      setTurns((now) => now.map((t) => (t.id === id ? { ...t, error: "The assistant could not be reached. Check your connection and try again." } : t)));
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

  async function dismiss(turnId: number, change: Change) {
    patch(turnId, change.id, { state: "dismissed" });
    try {
      await dismissChange(change.id);
    } catch {
      /* It simply expires if this does not reach the server. */
    }
  }

  return (
    <>
      <div className="assistant-thread" aria-live="polite">
        {turns.map((turn) => (
          <section key={turn.id} className="glass panel assistant-answer">
            <div className="assistant-question">{turn.question}</div>
            {turn.error && <p className="error">{turn.error}</p>}
            {turn.answer && <Answer text={turn.answer} />}
            {turn.changes.map((change) => (
              <div key={change.id} className={`change change-${change.state}`}>
                <div className="change-label">{change.state === "done" ? "Done" : change.state === "dismissed" ? "Not done" : "Waiting for you to confirm"}</div>
                <div className="change-summary">{change.summary}</div>
                {(change.state === "waiting" || change.state === "working" || change.state === "failed") && (
                  <>
                    {change.state === "failed" && <p className="error">{change.message}</p>}
                    <div className="actions">
                      <button type="button" className="btn btn-primary btn-small" disabled={change.state === "working"} onClick={() => confirm(turn.id, change)}>
                        {change.state === "working" ? "Working…" : "Confirm"}
                      </button>
                      <button type="button" className="btn btn-glass btn-small" disabled={change.state === "working"} onClick={() => dismiss(turn.id, change)}>
                        Don't do it
                      </button>
                    </div>
                  </>
                )}
                {change.state === "done" && (
                  <p className="notice">
                    {change.message}{" "}
                    {change.link && (
                      <Link href={change.link} className="row-link">
                        Open it
                      </Link>
                    )}
                  </p>
                )}
              </div>
            ))}
            {turn.answer && (
              <div className="muted footnote">
                {turn.lookups ? `From ${turn.lookups} ${turn.lookups === 1 ? "lookup" : "lookups"} of your records. ` : ""}The assistant can be wrong, so check before acting.
              </div>
            )}
          </section>
        ))}
        {pending && <p className="muted assistant-wait">Looking…</p>}
        <div ref={end} />
      </div>

      <section className="glass panel">
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void send(box.current?.value ?? "");
          }}
        >
          <label className="field">
            <span>{turns.length === 0 ? "Ask about your business, or ask for something to be done" : "Follow up"}</span>
            <textarea
              ref={box}
              name="question"
              rows={2}
              maxLength={1000}
              required
              disabled={disabled}
              placeholder={turns.length === 0 ? "Make a quote for Bayside Hardware: 20 pairs of work gloves" : "Make it 30 instead"}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send(event.currentTarget.value);
                }
              }}
            />
          </label>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={disabled || pending}>
              {pending ? "Looking…" : "Ask"}
            </button>
            {turns.length > 0 && !pending && (
              <button type="button" className="btn btn-glass" onClick={() => setTurns([])}>
                Start over
              </button>
            )}
          </div>
        </form>
        {!disabled && turns.length === 0 && (
          <div className="chips" aria-label="Examples">
            {suggestions.map((question) => (
              <button key={question} type="button" className="chip" onClick={() => void send(question)} disabled={pending}>
                {question}
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
