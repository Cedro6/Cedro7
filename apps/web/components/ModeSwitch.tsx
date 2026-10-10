"use client";

import { useEffect, useState } from "react";

type Mode = "dark" | "light";

/** Dark is the default. The choice is remembered on this device. */
export function ModeSwitch() {
  const [mode, setMode] = useState<Mode>("dark");
  useEffect(() => {
    setMode(document.documentElement.dataset.mode === "light" ? "light" : "dark");
  }, []);
  const toggle = () => {
    const next: Mode = mode === "dark" ? "light" : "dark";
    document.documentElement.dataset.mode = next;
    try {
      localStorage.setItem("cedro-mode", next);
    } catch {
      // the choice then lasts for this visit only
    }
    setMode(next);
  };
  return (
    <button type="button" className="mode-switch" onClick={toggle} aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
      {mode === "dark" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        </svg>
      )}
    </button>
  );
}
