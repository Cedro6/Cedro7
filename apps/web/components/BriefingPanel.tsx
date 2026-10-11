"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { writeMyBriefing } from "../app/(app)/assistant/actions";
import { AssistantText } from "./AssistantText";

/** Today's briefing on Home. It is written when asked for, then kept for the day. */
export function BriefingPanel({ initial, writtenAt }: { initial: string; writtenAt: string }) {
  const [body, setBody] = useState(initial);
  const [when, setWhen] = useState(writtenAt);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const write = () =>
    start(async () => {
      setError("");
      try {
        const result = await writeMyBriefing();
        if (result.error) setError(result.error);
        else {
          setBody(result.body);
          setWhen("just now");
        }
      } catch {
        setError("The briefing could not be written just now. Try again in a moment.");
      }
    });
  return (
    <section className="glass panel briefing" aria-live="polite">
      <div className="panel-head">
        <div>
          <h2 className="title">Today's briefing</h2>
          <div className="muted">{body ? `Written by the assistant ${when}` : "A short read on what matters today, written by the assistant from your records."}</div>
        </div>
        <button type="button" className="btn btn-glass btn-small" onClick={write} disabled={pending}>
          {pending ? "Writing…" : body ? "Write it again" : "Write today's briefing"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {body && (
        <div className="assistant-answer">
          <AssistantText text={body} />
          <div className="muted footnote">
            The assistant can be wrong, so check before acting. <Link href="/assistant">Ask a follow-up</Link>
          </div>
        </div>
      )}
    </section>
  );
}
