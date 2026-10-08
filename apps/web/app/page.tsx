import { appUrl, createPool, health } from "@bos/db/runtime";

export const dynamic = "force-dynamic";

const pool = createPool(appUrl());

/** Stage 0 status page. Sign-in and the real Home screen arrive in stage 1. */
export default async function StatusPage() {
  const db = await health(pool);
  return (
    <main className="page">
      <div>
        <div className="eyebrow">BusinessOS · foundation build</div>
        <h1>System status</h1>
      </div>
      <section className="glass panel">
        <div className="row">
          <span className="dot" style={{ background: db.ok ? "var(--ok)" : "var(--bad)" }} aria-hidden="true" />
          <div>
            <div style={{ fontWeight: 600 }}>Database {db.ok ? "connected" : "unreachable"}</div>
            <div className="muted">
              {db.ok ? `PostgreSQL ${db.serverVersion}, connected as the restricted app role` : db.error}
            </div>
          </div>
        </div>
        <div className="row">
          <span className="dot" style={{ background: "var(--warn)" }} aria-hidden="true" />
          <div>
            <div style={{ fontWeight: 600 }}>Sign-in not built yet</div>
            <div className="muted">No company data is shown until accounts and permissions exist.</div>
          </div>
        </div>
      </section>
    </main>
  );
}
