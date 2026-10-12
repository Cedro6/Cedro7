"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Detector = { detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
type DetectorClass = new (options?: { formats?: string[] }) => Detector;

/**
 * Where a scan or a typed code goes. The box keeps the cursor so a handheld scanner can be used
 * back to back. On phones whose browser can read barcodes, a camera button is offered as well.
 */
export function ScanBox({ initial }: { initial: string }) {
  const router = useRouter();
  const box = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [canScan, setCanScan] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [problem, setProblem] = useState("");

  const go = (code: string) => {
    const text = code.trim();
    if (text) router.push(`/warehouse?tab=lookup&code=${encodeURIComponent(text)}`);
  };

  useEffect(() => {
    setCanScan("BarcodeDetector" in window && Boolean(navigator.mediaDevices?.getUserMedia));
  }, []);
  useEffect(() => {
    // Ready for the next scan as soon as a result has loaded.
    box.current?.focus();
    box.current?.select();
  }, [initial]);

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
        const detector = new (window as unknown as { BarcodeDetector: DetectorClass }).BarcodeDetector();
        const look = async () => {
          if (stopped || !video.current) return;
          const found = await detector.detect(video.current).catch(() => []);
          if (found[0]?.rawValue) {
            setScanning(false);
            go(found[0].rawValue);
            return;
          }
          timer = window.setTimeout(look, 250);
        };
        void look();
      } catch {
        setProblem("The camera could not be used. Check that this site is allowed to use it, or type the code instead.");
        setScanning(false);
      }
    })();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [scanning]);

  return (
    <>
      <form
        className="form-row scan-row"
        onSubmit={(event) => {
          event.preventDefault();
          go(box.current?.value ?? "");
        }}
      >
        <label className="field grow">
          <span>Barcode, product code or name</span>
          <input ref={box} name="code" defaultValue={initial} autoComplete="off" autoCapitalize="off" spellCheck={false} enterKeyHint="search" />
        </label>
        <button type="submit" className="btn btn-primary">
          Look up
        </button>
        {canScan && (
          <button type="button" className="btn btn-glass" onClick={() => { setProblem(""); setScanning((now) => !now); }}>
            {scanning ? "Stop camera" : "Use camera"}
          </button>
        )}
      </form>
      {problem && <p className="error">{problem}</p>}
      {scanning && <video ref={video} className="scan-video" muted playsInline aria-label="Camera view. Point it at a barcode." />}
    </>
  );
}
