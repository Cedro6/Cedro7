"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

/** Home keeps the full look; every other screen is a denser working screen. The stylesheet keys off data-page. */
export function Main({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const ref = useRef<HTMLElement>(null);
  // On a phone each table row is shown as a labelled card, so nothing scrolls sideways.
  // The labels come from the column headings, so a new table needs no extra markup.
  useEffect(() => {
    for (const table of ref.current?.querySelectorAll("table") ?? []) {
      const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent?.trim() ?? "");
      if (!heads.length) continue;
      table.classList.add("cards-on-phone");
      for (const row of table.querySelectorAll("tbody tr")) {
        [...row.children].forEach((cell, i) => {
          if (i > 0 && heads[i] && !cell.hasAttribute("data-label")) cell.setAttribute("data-label", heads[i]!);
        });
      }
    }
  });
  return (
    <main ref={ref} className="content" id="main" data-page={pathname === "/" ? "home" : pathname.split("/")[1]}>
      {children}
    </main>
  );
}
