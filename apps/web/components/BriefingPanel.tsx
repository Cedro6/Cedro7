"use client";

import { useState, useTransition } from "react";
import { writeMyBriefing } from "../app/(app)/assistant/actions";
import { RichLine } from "./AssistantText";

/** Splits the briefing into its separate points: one per bullet, or one per paragraph or sentence when Ava wrote prose. */
function pointsOf(body: string): string[] {
  const marker = /^([-*•]|\d+[.)])\s+/;
  const lines = body.split("\n").map((l) => l.replace(/^#+\s*/, "").trim());
  const points: string[] = [];
  let fresh = true;
  for (const line of lines) {
    if (!line) { fresh = true; continue; }
    if (marker.test(line) || fresh || points.length === 0) points.push(line.replace(marker, ""));
    else points[points.length - 1] += " " + line;
    fresh = false;
  }
  // One long block of prose reads badly, so it is split into its sentences.
  if (points.length === 1 && points[0]!.length > 220) {
    const sentences = points[0]!.match(/[^.!?]+[.!?]+(?:\s*\[[^\]]+\]\([^)]*\))?(?:\s|$)|[^.!?]+$/g);
    if (sentences && sentences.length > 1) return sentences.map((x) => x.trim()).filter(Boolean);
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
        <div className="briefing-open" key={when + body.length}>
        <div className="briefing-glass">
          <ol className="briefing-points">
            {points.map((point, i) => (
              <li key={i} style={{ animationDelay: `${1.1 + i * 0.75}s` }}>
                <span className="briefing-num" aria-hidden="true">{i + 1}</span>
                <span className="briefing-point"><RichLine text={point} /></span>
              </li>
            ))}
          </ol>
          <div className="briefing-foot" style={{ animationDelay: `${1.1 + points.length * 0.75}s` }}>
            Ava can be wrong, so check before acting.{" "}
            <button type="button" className="link-button" onClick={() => window.dispatchEvent(new Event("ava:open"))}>Ask a follow-up</button>
          </div>
        </div>
        </div>
      )}
    </section>
  );
}
