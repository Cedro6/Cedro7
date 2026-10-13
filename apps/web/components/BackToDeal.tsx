import Link from "next/link";

/** The way back from a deal's paperwork to the deal itself. Hidden when the page is printed. */
export function BackToDeal({ id, number }: { id: string; number: string }) {
  return (
    <Link href={`/deals/${id}`} className="btn btn-glass back-link no-print">
      <span aria-hidden="true">←</span> Back to deal {number}
    </Link>
  );
}
