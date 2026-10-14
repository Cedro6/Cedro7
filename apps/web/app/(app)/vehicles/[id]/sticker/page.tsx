import Link from "next/link";
import { notFound } from "next/navigation";
import { can, coverPhotos, getCompanyProfile, getVehicle } from "@bos/core";
import { BackToVehicle } from "../../../../../components/BackToVehicle";
import { PrintButton } from "../../../../../components/PrintButton";
import { whole } from "../../../../../lib/locale";
import { requireSession } from "../../../../../lib/session";

/** A window sticker: the car, the price and the main specifications, on one printed page. */
export default async function WindowStickerPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requireSession();
  if (!can(ctx, "vehicle.read")) notFound();
  const { id } = await params;
  const car = await getVehicle(ctx, id);
  if (!car) notFound();
  const [company, cover] = await Promise.all([getCompanyProfile(ctx), coverPhotos(ctx, [car.id])]);
  const name = [car.year, car.make, car.model].filter(Boolean).join(" ") || "Vehicle";
  const engine = [car.displacementL ? `${car.displacementL}L` : null, car.cylinders ? `${car.cylinders}-cylinder` : null, car.engine].filter(Boolean).join(" ");
  const specs: [string, string | number | null | undefined][] = [
    ["Mileage", car.mileage === null || car.mileage === undefined ? null : `${car.mileage.toLocaleString("en-US")} miles`],
    ["Engine", engine || null], ["Transmission", car.transmission], ["Drivetrain", car.drivetrain], ["Fuel", car.fuelType],
    ["Body", car.bodyStyle], ["Doors", car.doors], ["Colour", car.colour], ["Condition", car.condition],
  ];
  const photo = cover[car.id];
  return (
    <>
      <header className="page-head no-print">
        <div>
          <div className="eyebrow"><Link href="/vehicles">Vehicles</Link> / <Link href={`/vehicles/${id}`}>{car.stockNumber}</Link></div>
          <h1>Window sticker</h1>
        </div>
        <BackToVehicle id={id} stockNumber={car.stockNumber} />
        <PrintButton />
      </header>
      {car.askingPrice === null || car.askingPrice === undefined ? <p className="notice no-print">This car has no asking price yet, so the sticker shows none. Add one on the car&apos;s page.</p> : null}
      <section className="paper sticker">
        <div className="sticker-dealer">{company.name}{company.phone ? ` · ${company.phone}` : ""}</div>
        <h2 className="sticker-name">{name}</h2>
        {car.trim && <div className="sticker-trim">{car.trim}</div>}
        {photo && <img className="sticker-photo" src={`/files/${photo}`} alt={name} />}
        <div className="sticker-price">{car.askingPrice === null || car.askingPrice === undefined ? "Ask about price" : whole(car.askingPrice)}</div>
        <div className="sticker-tax">Plus tax, tag, title and dealer fees</div>
        <dl className="sticker-specs">
          {specs.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        {car.description && <p className="sticker-desc">{car.description}</p>}
        <div className="sticker-foot mono">Stock {car.stockNumber}{car.vin ? ` · VIN ${car.vin}` : ""}</div>
      </section>
    </>
  );
}
