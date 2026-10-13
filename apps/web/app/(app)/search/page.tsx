import Link from "next/link";
import { search, SEARCH_MIN } from "@bos/core";
import { SearchBox } from "../../../components/SearchBox";
import { requireSession } from "../../../lib/session";

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { ctx } = await requireSession();
  const q = ((await searchParams).q ?? "").trim().slice(0, 80);
  const groups = await search(ctx, q);
  const total = groups.reduce((n, g) => n + g.hits.length, 0);
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">{q.length >= SEARCH_MIN ? `${total} ${groups.some((g) => g.close) ? (total === 1 ? "close match" : "close matches") : total === 1 ? "result" : "results"}${groups.some((g) => g.more) ? " shown" : ""}` : "Everything you can see"}</div>
          <h1>Search</h1>
        </div>
        <SearchBox initial={q} />
      </header>
      {q.length < SEARCH_MIN ? (
        <section className="glass panel empty">
          <div className="empty-title">Type at least {SEARCH_MIN} letters or digits</div>
          <p>Search looks through customers and their contacts, products, orders, invoices, purchase orders, suppliers and bills, whichever of those your role can see.</p>
        </section>
      ) : groups.length === 0 ? (
        <section className="glass panel empty">
          <div className="empty-title">Nothing matches &ldquo;{q}&rdquo;</div>
          <p>Try fewer letters, or part of a number such as 0042.</p>
        </section>
      ) : (
        [
          ...(groups.some((g) => g.close) ? [<p className="notice" key="close">Nothing matches &ldquo;{q}&rdquo; exactly. These are the closest:</p>] : []),
          ...groups.map((g) => (
          <section className="glass panel" key={g.kind}>
            <h2 className="title">{g.label}</h2>
            <div className="rows">
              {g.hits.map((h) => (
                <Link href={h.href} className="row search-hit" key={h.id}>
                  <div className="row-text">
                    <div className="row-title">{h.title}</div>
                    {h.detail && <div className="muted">{h.detail}</div>}
                  </div>
                </Link>
              ))}
            </div>
            {g.more && <p className="muted footnote">More match. Add a few letters to narrow it down.</p>}
          </section>
          )),
        ]
      )}
    </>
  );
}
