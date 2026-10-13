"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { VinLookup } from "@bos/core";
import { lookupVinAction, saveNewVehicle } from "../app/(app)/vehicles/actions";
import { OwnFields, SpecFields } from "./VehicleFields";

type Detector = { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
type DetectorClass = new (options?: { formats?: string[] }) => Detector;

/**
 * Add a vehicle by VIN: type, paste or scan it, see what the VIN says, add what it cannot, save.
 * Manual entry is the same screen with the VIN left out.
 */
export function AddByVin({ showCost, currency, manual }: { showCost: boolean; currency: string; manual: boolean }) {
  const router = useRouter();
  const [vin, setVin] = useState("");
  const [lookup, setLookup] = useState<VinLookup | null>(null);
  const [typing, setTyping] = useState(manual);
  const [error, setError] = useState("");
  const [busy, start] = useTransition();
  const [canScan, setCanScan] = useState(false);
  const [scanning, setScanning] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCanScan("BarcodeDetector" in window && Boolean(navigator.mediaDevices?.getUserMedia));
    box.current?.focus();
  }, []);

  const look = (value: string) => {
    const text = value.trim();
    if (!text) return;
    setError("");
    start(async () => {
      const result = await lookupVinAction(text);
      if (result.ok) {
        setLookup(result.lookup);
        setVin(result.lookup.vin);
      } else setError(result.error);
    });
  };

  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer = 0;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (stopped || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const detector = new (window as unknown as { BarcodeDetector: DetectorClass }).BarcodeDetector({ formats: ["code_39", "code_128", "qr_code", "data_matrix"] });
        const peek = async () => {
          if (stopped || !video.current) return;
          const found = await detector.detect(video.current).catch(() => []);
          // A VIN barcode sometimes carries a leading "I" (import marker); the cleaner drops it.
          const hit = found.map((f) => f.rawValue.replace(/^I(?=[A-HJ-NPR-Z0-9]{17}$)/, "")).find((v) => /^[A-HJ-NPR-Z0-9]{17}$/i.test(v.trim()));
          if (hit) {
            setScanning(false);
            setVin(hit);
            look(hit);
            return;
          }
          timer = window.setTimeout(peek, 250);
        };
        void peek();
      } catch {
        setError("The camera could not be used. Check that this site is allowed to use it, or type the VIN instead.");
        setScanning(false);
      }
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [scanning]);

  const save = (form: FormData) => {
    setError("");
    start(async () => {
      const result = await saveNewVehicle(form);
      if (result.ok) router.push(`/vehicles/${result.id}?notice=${encodeURIComponent(`${result.stockNumber} added.`)}`);
      else setError(result.error);
    });
  };

  const decoded = lookup?.decoded;
  const reviewing = Boolean(lookup) || typing;
  return (
    <>
      {!reviewing && (
        <section className="glass panel veh-entry">
          <form onSubmit={(e) => { e.preventDefault(); look(vin); }} className="stack">
            <label className="field veh-vin-field">
              <span>VIN</span>
              <input
                ref={box} value={vin} onChange={(e) => setVin(e.target.value.toUpperCase())} maxLength={20} autoComplete="off" spellCheck={false}
                placeholder="17 characters, from the door jamb or the dash" className="veh-vin-input" aria-describedby="vin-help"
              />
            </label>
            <p id="vin-help" className="muted">Type it, paste it, or scan the barcode on the door sticker. Nothing is saved until you have reviewed what the VIN says.</p>
            {error && <p className="error">{error}</p>}
            <div className="actions">
              <button type="submit" className="btn btn-primary" disabled={busy || vin.trim().length < 11}>{busy ? "Decoding…" : "Decode VIN"}</button>
              {canScan && <button type="button" className="btn btn-glass" onClick={() => { setError(""); setScanning((s) => !s); }}>{scanning ? "Stop camera" : "Scan VIN"}</button>}
              <Link href="/vehicles/import" className="btn btn-glass">Bulk import VINs</Link>
              <button type="button" className="btn btn-glass" onClick={() => setTyping(true)}>Add without a VIN</button>
            </div>
            {scanning && <video ref={video} className="scan-video" muted playsInline aria-label="Camera view for scanning" />}
          </form>
        </section>
      )}

      {reviewing && (
        <form action={save} className="stack-panels">
          <input type="hidden" name="vin" value={lookup?.vin ?? ""} />
          <section className="glass panel">
            <div className="panel-head">
              <div>
                <h2 className="title">{lookup ? `What the VIN says` : "Vehicle details"}</h2>
                <p className="muted">
                  {lookup && decoded
                    ? `${lookup.vin}: decoded by ${decoded.provider === "vpic" ? "the NHTSA vPIC service" : decoded.provider}. Check it, and fill anything it could not say.`
                    : lookup
                      ? `${lookup.vin}: the VIN could not be decoded, so type the details.`
                      : "No VIN needed: type what you know. Make and model are enough to start, and a VIN can be added later on the vehicle's page."}
                </p>
              </div>
              {lookup && <button type="button" className="btn btn-glass btn-small" onClick={() => { setLookup(null); setTyping(false); setError(""); }}>Different VIN</button>}
            </div>
            {lookup?.duplicate && (
              <p className="error">
                This VIN is already on the lot as <Link href={`/vehicles/${lookup.duplicate.id}`} className="row-link">{lookup.duplicate.stockNumber}</Link>. It cannot be added twice.
              </p>
            )}
            {lookup?.warnings.map((w) => <p className="notice" key={w}>The decoder says: {w}</p>)}
            {lookup && decoded && lookup.missing.length > 0 && (
              <p className="muted veh-missing-note">Not in the VIN data: {lookup.missing.length} {lookup.missing.length === 1 ? "field" : "fields"}, marked below. Leave them blank rather than guess.</p>
            )}
            <SpecFields
              values={decoded?.specs ?? {}}
              provenance={decoded ? Object.fromEntries(Object.keys(decoded.specs).map((k) => [k, "decoder"])) : undefined}
              missing={lookup && decoded ? lookup.missing : undefined}
            />
            {decoded && Object.keys(decoded.extra).length > 0 && (
              <details className="veh-extra">
                <summary>Everything else the decoder knew ({Object.keys(decoded.extra).length})</summary>
                <dl className="veh-dl">
                  {Object.entries(decoded.extra).map(([k, v]) => <div key={k}><dt>{k.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt><dd>{v}</dd></div>)}
                </dl>
              </details>
            )}
          </section>
          <section className="glass panel">
            <h2 className="title">About this car</h2>
            <p className="muted">The VIN cannot tell you these. Mileage and condition are what you saw; the price is what you paid.</p>
            <OwnFields values={{}} showCost={showCost} currency={currency} />
          </section>
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={busy || Boolean(lookup?.duplicate)}>{busy ? "Saving…" : "Add to the lot"}</button>
            <Link href="/vehicles" className="btn btn-glass">Cancel</Link>
          </div>
          <p className="muted footnote">A stock number is given when you save. A VIN proves what the car was built as, not its title, ownership, condition, accident history or mileage.</p>
        </form>
      )}
    </>
  );
}
