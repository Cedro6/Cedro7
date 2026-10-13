"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import type { VehicleImportRow } from "@bos/core";
import { checkVehicleImport, doVehicleImport } from "../app/(app)/vehicles/actions";

const MAX_BYTES = 400_000;

/** A file of VINs in, a decoded list to check, then the records. Rows with a problem are shown and skipped. */
export function VinImportTool() {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [rows, setRows] = useState<VehicleImportRow[] | null>(null);
  const [ready, setReady] = useState(0);
  const [added, setAdded] = useState<{ id: string; stockNumber: string; vin: string }[] | null>(null);
  const [error, setError] = useState("");
  const [busy, begin] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  const choose = async (picked: File | undefined) => {
    if (!picked) return;
    setRows(null); setAdded(null); setError("");
    if (picked.size > MAX_BYTES) { setError("That file is too large. Import at most 500 VINs at a time."); return; }
    if (/\.(xlsx?|numbers|ods)$/i.test(picked.name)) { setError("That is a spreadsheet workbook. In your spreadsheet program choose File, then Save As or Download, and pick CSV. Then choose that file here."); return; }
    const next = { name: picked.name, text: await picked.text() };
    setFile(next);
    begin(async () => {
      const result = await checkVehicleImport(next.text);
      if (result.ok) { setRows(result.rows); setReady(result.ready); } else setError(result.error);
    });
  };
  const run = () => {
    if (!file) return;
    begin(async () => {
      const result = await doVehicleImport(file.text);
      if (result.ok) setAdded(result.added); else setError(result.error);
    });
  };

  return (
    <>
      <section className="glass panel">
        <p>One VIN per row. A header row is optional; columns named <b>mileage</b>, <b>color</b>, <b>cost</b>, <b>source</b>, <b>price</b> or <b>notes</b> are read too. Each VIN is checked and decoded before anything is saved.</p>
        <div className="actions">
          <input ref={input} type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(e) => void choose(e.target.files?.[0])} disabled={busy} />
          {file && <span className="muted">{file.name}</span>}
        </div>
        {busy && !rows && <p className="muted">Checking and decoding each VIN…</p>}
        {error && <p className="error">{error}</p>}
      </section>
      {rows && !added && (
        <section className="glass panel">
          <div className="panel-head">
            <div>
              <h2 className="title">{ready} of {rows.length} will be added</h2>
              <p className="muted">Rows with a problem are skipped; fix them in the file and choose it again, or import the rest now.</p>
            </div>
            <button type="button" className="btn btn-primary" onClick={run} disabled={busy || ready === 0}>{busy ? "Importing…" : `Import ${ready}`}</button>
          </div>
          <div className="table-wrap">
            <table className="compact">
              <thead><tr><th>Row</th><th>VIN</th><th>Decoded as</th><th>Result</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.row}>
                    <td className="num">{r.row}</td>
                    <td className="mono">{r.given || <span className="muted">blank</span>}</td>
                    <td>{r.summary || "—"}{r.lookup?.warnings.length ? <span className="muted"> · {r.lookup.warnings[0]}</span> : null}</td>
                    <td>{r.problem ? <span className="badge badge-bad">{r.problem}</span> : <span className="badge badge-ok">Will be added</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {added && (
        <section className="glass panel">
          <h2 className="title">{added.length} {added.length === 1 ? "vehicle" : "vehicles"} added</h2>
          <ul className="veh-added">
            {added.map((a) => <li key={a.id}><Link href={`/vehicles/${a.id}`} className="row-link">{a.stockNumber}</Link> <span className="mono muted">{a.vin}</span></li>)}
          </ul>
          <div className="actions"><Link href="/vehicles" className="btn btn-primary">Go to the lot</Link></div>
        </section>
      )}
    </>
  );
}
