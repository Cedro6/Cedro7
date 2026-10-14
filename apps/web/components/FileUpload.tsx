"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

/** The longest side a photo is shrunk to before upload, and the JPEG quality. Plenty for a listing or a readable scan. */
const MAX_SIDE = 2000;
const QUALITY = 0.82;
const MAX_BYTES = 4_400_000;

/** Shrinks a photo in the browser to a JPEG. A PDF, or a photo already small enough, is sent as it is. */
async function shrink(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_500_000 && ["image/jpeg", "image/png", "image/webp"].includes(file.type)) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", QUALITY));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/**
 * Adds files to a deal or a car. Photos are shrunk first; several can be chosen at once. Without the
 * script the same form posts straight to the server and comes back to this page.
 */
export function FileUpload({ dealId, vehicleId, kinds, accept, label }: {
  dealId?: string; vehicleId?: string;
  /** What the file is, for a deal. A car's files are always photos. */
  kinds?: { value: string; label: string }[];
  accept: string; label: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ busy: boolean; message: string; error: boolean }>({ busy: false, message: "", error: false });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const chosen = Array.from(input.current?.files ?? []);
    if (!chosen.length) return setState({ busy: false, message: "Choose a file first.", error: true });
    setState({ busy: true, message: chosen.length === 1 ? "Uploading…" : `Uploading ${chosen.length} files…`, error: false });
    const kind = new FormData(event.currentTarget).get("kind");
    let done = 0;
    for (const original of chosen) {
      const file = await shrink(original);
      if (file.size > MAX_BYTES) {
        setState({ busy: false, message: `${original.name} is over 4.4 MB even after shrinking. Scan it at a lower resolution, or split it into pages.`, error: true });
        router.refresh();
        return;
      }
      const body = new FormData();
      if (dealId) body.set("dealId", dealId);
      if (vehicleId) body.set("vehicleId", vehicleId);
      if (kind) body.set("kind", String(kind));
      body.set("file", file);
      const response = await fetch("/api/dealer-files", { method: "POST", body, headers: { accept: "application/json" } }).catch(() => null);
      const result = response ? ((await response.json().catch(() => ({}))) as { error?: string }) : { error: "The connection dropped. Try again." };
      if (!response?.ok) {
        setState({ busy: false, message: `${original.name}: ${result.error ?? "could not be saved."}`, error: true });
        router.refresh();
        return;
      }
      done++;
      setState({ busy: true, message: `Uploaded ${done} of ${chosen.length}…`, error: false });
    }
    if (input.current) input.current.value = "";
    setState({ busy: false, message: done === 1 ? "File added." : `${done} files added.`, error: false });
    router.refresh();
  }

  return (
    <form action="/api/dealer-files" method="post" encType="multipart/form-data" onSubmit={submit} className="upload-form">
      {dealId && <input type="hidden" name="dealId" value={dealId} />}
      {vehicleId && <input type="hidden" name="vehicleId" value={vehicleId} />}
      {kinds && (
        <label className="field">
          <span>What it is</span>
          <select name="kind" defaultValue={kinds[0]?.value}>{kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select>
        </label>
      )}
      <label className="field upload-pick">
        <span>{label}</span>
        <input ref={input} type="file" name="file" accept={accept} multiple required />
      </label>
      <div className="field">
        <span>&nbsp;</span>
        <button type="submit" className="btn btn-primary" disabled={state.busy}>{state.busy ? "Uploading…" : "Upload"}</button>
      </div>
      {state.message && <p className={state.error ? "error upload-msg" : "muted upload-msg"} role="status">{state.message}</p>}
    </form>
  );
}
