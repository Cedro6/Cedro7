"use client";

import { useState, useTransition } from "react";
import { writeMyBriefing } from "../app/(app)/assistant/actions";
import { RichLine } from "./AssistantText";

/** Splits the briefing into its separate points. A line that is not a bullet stays with the point above it. */
function pointsOf(body: string): string[] {
  const points: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (!line) continue;
    const bullet = /^([-*•]|\d+[.)])\s+/.test(line);
    if (bullet || points.length === 0) points.push(line.replace(/^([-*•]|\d+[.)])\s+/, ""));
    else points[points.length - 1] += " " + line;
  }
  return points;
}

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
  const points = pointsOf(body);
  return (
    <section className={`glass panel briefing briefing-art ${body ? "is-written" : ""}`} aria-live="polite">
      <div className="panel-head">
        <div>
          <h2 className="briefing-title">Today&apos;s briefing</h2>
          <div className="briefing-sub">{body ? `Written by Ava ${when}` : "A short read on what matters today, written by Ava from your records."}</div>
        </div>
        <button type="button" className="btn btn-glass btn-small" onClick={write} disabled={pending}>
          {pending ? "Writing…" : body ? "Write it again" : "Write today's briefing"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {body && (
        // The key restarts the reveal each time the briefing is written again.
        <div className="briefing-glass" key={when + body.length}>
          <ol className="briefing-points">
            {points.map((point, i) => (
              <li key={i} style={{ animationDelay: `${0.25 + i * 0.22}s` }}>
                <span className="briefing-num" aria-hidden="true">{i + 1}</span>
                <span className="briefing-point"><RichLine text={point} /></span>
              </li>
            ))}
          </ol>
          <div className="briefing-foot">
            Ava can be wrong, so check before acting.{" "}
            <button type="button" className="link-button" onClick={() => window.dispatchEvent(new Event("ava:open"))}>Ask a follow-up</button>
          </div>
        </div>
      )}
    </section>
  );
}
