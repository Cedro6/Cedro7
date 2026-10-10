"use client";

/** Opens the browser's print dialog, which is also how the document is saved as a PDF. */
export function PrintButton({ label = "Print or save as PDF" }: { label?: string }) {
  return (
    <button type="button" className="btn btn-glass" onClick={() => window.print()}>
      {label}
    </button>
  );
}
