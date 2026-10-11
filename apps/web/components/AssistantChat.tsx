"use client";

import Link from "next/link";
import { useActionState, useRef, type ReactNode } from "react";
import { askAssistant, type AskState } from "../app/(app)/assistant/actions";

const START: AskState = { question: "", answer: "", error: "", lookups: 0 };

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

export function AssistantChat({ suggestions, disabled }: { suggestions: string[]; disabled: boolean }) {
  const [state, action, pending] = useActionState(askAssistant, START);
  const box = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const askThis = (question: string) => {
    if (!box.current || pending) return;
    box.current.value = question;
    form.current?.requestSubmit();
  };
  return (
    <>
      <section className="glass panel">
        <form ref={form} action={action} className="stack">
          <label className="field">
            <span>Ask about your business</span>
            <textarea
              ref={box}
              name="question"
              rows={2}
              maxLength={1000}
              required
              disabled={disabled}
              defaultValue={state.question}
              placeholder="Who owes us money?"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  form.current?.requestSubmit();
                }
              }}
            />
          </label>
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={disabled || pending}>
              {pending ? "Looking…" : "Ask"}
            </button>
          </div>
        </form>
        {!disabled && (
          <div className="chips" aria-label="Example questions">
            {suggestions.map((question) => (
              <button key={question} type="button" className="chip" onClick={() => askThis(question)} disabled={pending}>
                {question}
              </button>
            ))}
          </div>
        )}
      </section>
      <div aria-live="polite">
        {state.error && <p className="error">{state.error}</p>}
        {state.answer && !pending && (
          <section className="glass panel assistant-answer">
            <div className="muted">{state.question}</div>
            {state.answer.split(/\n{2,}/).map((paragraph, index) => (
              <p key={index}>
                {paragraph.split("\n").map((line, i) => (
                  <span key={i} className="assistant-line">
                    {rich(line.replace(/^\s*[-*•]\s+/, "• ").replace(/^#+\s*/, ""))}
                  </span>
                ))}
              </p>
            ))}
            <div className="muted footnote">
              {state.lookups > 0 ? `Answered from ${state.lookups} ${state.lookups === 1 ? "lookup" : "lookups"} of your records.` : "Answered without looking anything up."} The
              assistant can be wrong, so check the linked records before acting.
            </div>
          </section>
        )}
      </div>
    </>
  );
}
