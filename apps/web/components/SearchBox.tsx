"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

/** The search page's box. Results follow what is typed after a short pause; Enter still works without waiting. */
export function SearchBox({ initial }: { initial: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [pending, start] = useTransition();
  const shown = useRef(initial);
  useEffect(() => {
    const q = value.trim();
    if (q === shown.current) return;
    const timer = setTimeout(() => {
      shown.current = q;
      start(() => router.replace(q ? `/search?q=${encodeURIComponent(q)}` : "/search", { scroll: false }));
    }, 250);
    return () => clearTimeout(timer);
  }, [value, router]);
  return (
    <form action="/search" className="glass search" role="search" aria-busy={pending}>
      <label htmlFor="search-page-q" className="sr-only">Search</label>
      <input id="search-page-q" name="q" type="search" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Name, number, code or barcode" autoFocus maxLength={80} autoComplete="off" />
    </form>
  );
}
