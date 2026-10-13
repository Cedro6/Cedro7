"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import type { ImportPlan } from "@bos/core";
import { checkImport, doImport } from "../app/(app)/import/actions";

type Kind = { key: string; label: string; columns: { label: string; required: boolean }[]; listHref: string };
const MAX_BYTES = 700_000;
const SHOWN = 200;
const WORD = { add: "Will be added", skip: "Skipped", error: "Needs fixing" } as const;
const DONE_WORD = { add: "Added", skip: "Skipped", error: "Not imported" } as const;
const TONE = { add: "badge-ok", skip: "badge-muted", error: "badge-bad" } as const;

/** Choose a file, see exactly what it would do, then import it. */
export function ImportTool({ kinds, start }: { kinds: Kind[]; start: string }) {
  const [kind, setKind] = useState(start);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [busy, begin] = useTransition();
  const key = useRef("");
  const input = useRef<HTMLInputElement>(null);
  const current = kinds.find((k) => k.key === kind) ?? kinds[0]!;

  const reset = () => {
    setFile(null); setPlan(null); setDone(false); setError("");
    if (input.current) input.current.value = "";
  };
  const check = (next: { name: string; text: string }, as: string) => {
    setFile(next); setPlan(null); setDone(false); setError("");
    key.current = crypto.randomUUID();
    begin(async () => {
      const result = await checkImport(as, next.text);
      if (result.ok) setPlan(result.plan);
      else setError(result.error);
    });
  };
  const choose = async (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > MAX_BYTES) { reset(); setError("That file is too large. Split it into files of at most 2,000 rows."); return; }
    if (/\.(xlsx?|numbers|ods)$/i.test(picked.name)) { reset(); setError("That is a spreadsheet workbook. In your spreadsheet program choose File, then Save As or Download, and pick CSV. Then choose that file here."); return; }
    check({ name: picked.name, text: await picked.text() }, kind);
  };
  const run = () => {
    if (!file) return;
    setError("");
    begin(async () => {
      const result = await doImport(kind, file.text, key.current);
      if (result.ok) { setPlan(result.plan); setDone(true); }
      else setError(result.error);
    });
  };

  const words = done ? DONE_WORD : WORD;
  return (
    <>
      <section className="glass panel">
        <h2 className="title">1. Choose what to import</h2>
        <div className="segmented imp-kinds" role="group" aria-label="What to import">
          {kinds.map((k) => (
            <label key={k.key}>
              <input type="radio" name="kind" value={k.key} checked={k.key === kind} onChange={() => { setKind(k.key); if (file && !done) check(file, k.key); else reset(); }} />
              <span>{k.label}</span>
            </label>
          ))}
        </div>
        <p className="muted">
          The first row of the file must be headings. These are understood:{" "}
          {current.columns.map((c, i) => (
            <span key={c.label}>{i > 0 && ", "}<strong>{c.label}</strong>{c.required && " (needed)"}</span>
          ))}
          . Other columns are ignored.
        </p>
        <p><a className="btn btn-glass btn-small" href={`/import/template?kind=${current.key}`} download>Download a blank {current.label.toLowerCase()} file</a></p>
      </section>

      <section className="glass panel">
        <h2 className="title">2. Choose the file</h2>
        <p className="muted">A CSV file. In Excel or Google Sheets: File, then Save As or Download, then CSV. Nothing is imported until you press Import in step 3.</p>
        <label className="field imp-file">
          <span className="sr-only">File to import</span>
          <input ref={input} type="file" accept=".csv,.tsv,.txt,text/csv" disabled={busy} onChange={(e) => choose(e.target.files?.[0])} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        {busy && !plan && <p className="muted" role="status">Reading the file…</p>}
      </section>

      {plan && file && (
        <section className="glass panel">
          <div className="panel-head">
            <div>
              <h2 className="title">{done ? "Done" : "3. Check and import"}</h2>
              <p className="muted">
                {file.name}: {plan.rows.length} {plan.rows.length === 1 ? "row" : "rows"}.{" "}
                <strong>{plan.add} {done ? "added" : "will be added"}</strong>, {plan.skip} skipped, {plan.errors} {done ? "not imported" : plan.errors === 1 ? "needs fixing" : "need fixing"}.
              </p>
            </div>
            {done ? (
              <div className="badges">
                <Link href={current.listHref} className="btn btn-primary btn-small">See {current.label.toLowerCase()}</Link>
                <button type="button" className="btn btn-glass btn-small" onClick={reset}>Import another file</button>
              </div>
            ) : (
              <button type="button" className="btn btn-primary" disabled={busy || plan.add === 0} onClick={run}>
                {busy ? "Importing…" : plan.add === 0 ? "Nothing to import" : `Import ${plan.add} ${plan.add === 1 ? "row" : "rows"}`}
              </button>
            )}
          </div>
          {done && <p className="notice" role="status">{plan.add} {plan.add === 1 ? "row was" : "rows were"} imported.</p>}
          {!done && plan.errors > 0 && plan.add > 0 && <p className="muted">Rows that need fixing are left out. You can fix them in the file and import it again; rows already imported are skipped.</p>}
          {plan.notes.map((n) => <p className="muted" key={n}>{n}</p>)}
          <div className="table-wrap">
            <table className="compact">
              <thead><tr><th scope="col">Row</th><th scope="col">{current.label === "Products" ? "Product" : "Customer"}</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
              <tbody>
                {[...plan.rows].sort((a, b) => Number(b.action === "error") - Number(a.action === "error")).slice(0, SHOWN).map((r) => (
                  <tr key={r.line}>
                    <td>{r.line}</td>
                    <td>{r.label}</td>
                    <td><span className={`badge ${TONE[r.action]}`}>{words[r.action]}</span></td>
                    <td className="muted">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.rows.length > SHOWN && <p className="muted footnote">Showing {SHOWN} of {plan.rows.length} rows, the ones that need fixing first.</p>}
        </section>
      )}
    </>
  );
}
