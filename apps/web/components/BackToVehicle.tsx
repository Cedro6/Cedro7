import Link from "next/link";

/** The way back from a car's printouts to the car. Hidden when the page is printed. */
export function BackToVehicle({ id, stockNumber }: { id: string; stockNumber: string }) {
  return (
    <Link href={`/vehicles/${id}`} className="btn btn-glass back-link no-print">
      <span aria-hidden="true">←</span> Back to {stockNumber}
    </Link>
  );
}
