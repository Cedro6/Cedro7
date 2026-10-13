"use client";

import { useEffect, useState, useTransition } from "react";
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

/** The record a point is about: the first link in it. */
const linkOf = (point: string) => point.match(/\]\((\/[^)\s]+)\)/)?.[1] ?? "";

/**
 * Today's briefing on Home. It is written when asked for and then stays open for the rest of the day.
 * A point crosses itself off once the record it links has been dealt with.
 */
export function BriefingPanel({ initial, writtenAt, done, day }: { initial: string; writtenAt: string; done: string[]; day: string }) {
  // A saved briefing that stops mid-sentence (from before this was fixed) is ignored, so asking writes a fresh one.
  const [body, setBody] = useState(/[.!?)]\s*$/.test(initial) ? initial : "");
  const [when, setWhen] = useState(writtenAt);
  const [error, setError] = useState("");
  // "asked" plays the slow reveal; "kept" is a briefing already opened earlier today, shown at once.
  const [shown, setShown] = useState<"no" | "asked" | "kept">("no");
  const [pending, start] = useTransition();
  useEffect(() => {
    try {
      if (localStorage.getItem("cedro-briefing-open") === day) setShown((now) => (now === "no" ? "kept" : now));
    } catch { /* it simply starts closed */ }
  }, [day]);
  const reveal = () => {
    setShown("asked");
    try { localStorage.setItem("cedro-briefing-open", day); } catch { /* open for this visit only */ }
  };
  const write = () =>
    start(async () => {
      setError("");
      try {
        const result = await writeMyBriefing();
        if (result.error) setError(result.error);
        else {
          setBody(result.body);
          setWhen("just now");
          reveal();
        }
      } catch {
        setError("The briefing could not be written just now. Try again in a moment.");
      }
    });
  // Asking for a briefing that was already written today shows it straight away; it is not written (or counted) twice.
  const ask = () => (body && shown === "no" ? reveal() : write());
  const open = shown !== "no" && Boolean(body);
  const all = pointsOf(body).map((text) => ({ text, done: done.includes(linkOf(text)) }));
  // What is still to do comes first; what has been dealt with sinks to the bottom, crossed off.
  const points = [...all.filter((p) => !p.done), ...all.filter((p) => p.done)];
  const left = all.filter((p) => !p.done).length;
  const cleared = open && all.length > 0 && left === 0;
  return (
    <section className={`glass panel briefing briefing-art ${open ? "is-written" : ""} ${shown === "kept" ? "is-kept" : ""}`} aria-live="polite">
      <div className="panel-head">
        <div>
          <h2 className="briefing-title">Today&apos;s briefing</h2>
          <div className="briefing-sub">
            {!open ? "A short read on what matters today, written by Ava from your records."
              : cleared ? "Everything Ava raised today has been dealt with. Nothing else needs you."
              : `Written by Ava ${when}${all.length > left ? ` · ${all.length - left} of ${all.length} dealt with` : ""}`}
          </div>
        </div>
        <button type="button" className="btn btn-glass btn-small" onClick={ask} disabled={pending}>
          {pending ? "Writing…" : open ? "Write it again" : "Write today's briefing"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {open && !cleared && (
        // The key restarts the reveal each time the briefing is written again.
        <div className="briefing-open" key={when + body.length}>
          <div className="briefing-glass">
            <ol className="briefing-points">
              {points.map((point, i) => (
                <li key={point.text} className={point.done ? "is-done" : ""} style={{ animationDelay: `${1.1 + i * 0.75}s` }}>
                  <span className="briefing-num" aria-hidden="true">
                    {point.done ? (
                      <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8" /></svg>
                    ) : (
                      i + 1
                    )}
                  </span>
                  <span className="briefing-point">
                    {point.done && <span className="sr-only">Dealt with: </span>}
                    <RichLine text={point.text} />
                  </span>
                </li>
              ))}
            </ol>
            <div className="briefing-foot" style={{ animationDelay: `${1.1 + points.length * 0.75}s` }}>
              Points cross themselves off as you deal with them. Ava can be wrong, so check before acting.{" "}
              <button type="button" className="link-button" onClick={() => window.dispatchEvent(new Event("ava:open"))}>Ask a follow-up</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
