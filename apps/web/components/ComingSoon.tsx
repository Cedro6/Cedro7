import type { ReactNode } from "react";

/** A module that is planned but not built. States plainly what will be here and when. */
export function ComingSoon({ title, stage, children }: { title: string; stage: string; children: ReactNode }) {
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">{stage}</div>
          <h1>{title}</h1>
        </div>
      </header>
      <section className="glass panel empty">
        <div className="empty-title">Not built yet</div>
        <p>{children}</p>
      </section>
    </>
  );
}
