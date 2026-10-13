import Link from "next/link";
import { redirect } from "next/navigation";
import { can, featureOn, listDeals, type DealStatus } from "@bos/core";
import { SearchIcon } from "../../../components/icons";
import { whole } from "../../../lib/locale";
import { requireSession } from "../../../lib/session";

const WORD: Record<DealStatus, string> = { open: "Open", delivered: "Delivered", cancelled: "Cancelled" };

export default async function DealsPage({ searchParams }: { searchParams: Promise<{ q?: string; show?: string }> }) {
  const { ctx } = await requireSession();
  if (!featureOn(ctx.features, "dealer") || !can(ctx, "vehicle.read")) redirect("/");
  const params = await searchParams;
  const q = params.q?.trim() ?? "";
  const show = params.show === "delivered" || params.show === "cancelled" ? params.show : params.show === "all" ? undefined : "open";
  const deals = await listDeals(ctx, { status: q ? undefined : show, search: q });
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">Dealer Terminal</div>
          <h1>Deals</h1>
        </div>
        <form className="glass search" role="search">
          <SearchIcon />
          <label className="sr-only" htmlFor="q">Search deals</label>
          <input id="q" name="q" type="search" placeholder="Deal number, buyer, stock number or VIN" defaultValue={q} />
        </form>
        {can(ctx, "vehicle.write") && <Link href="/deals/new" className="btn btn-primary">New deal</Link>}
      </header>
      {!q && (
        <nav className="segmented rpt-tabs" aria-label="Show">
          {[["open", "Open"], ["delivered", "Delivered"], ["cancelled", "Cancelled"], ["all", "All"]].map(([k, label]) => (
            <Link key={k} href={`/deals?show=${k}`} aria-current={(show ?? "all") === k ? "page" : undefined}>{label}</Link>
          ))}
        </nav>
      )}
      <section className="glass panel">
        {deals.length === 0 ? (
          <div className="empty">
            <div className="empty-title">{q ? "No deals match that search" : "No deals here"}</div>
            <p>{q ? "Try the deal number or the buyer's name." : "Start a deal from a vehicle's page, or with New deal."}</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Deal</th><th>Buyer</th><th>Vehicle</th><th className="num">Total</th><th className="num">Owed</th><th>Status</th></tr></thead>
              <tbody>
                {deals.map((d) => (
                  <tr key={d.id}>
                    <td><Link href={`/deals/${d.id}`} className="row-link">{d.number}</Link></td>
                    <td>{d.buyerName}</td>
                    <td>{d.vehicleName || d.stockNumber} <span className="muted mono">{d.stockNumber}</span></td>
                    <td className="num">{whole(d.total)}</td>
                    <td className="num">{d.status === "open" && d.balance > 0 ? whole(d.balance) : "—"}</td>
                    <td><span className={`badge ${d.status === "delivered" ? "badge-ok" : d.status === "cancelled" ? "badge-muted" : "badge-info"}`}>{WORD[d.status]}{d.deliveredOn ? ` ${d.deliveredOn}` : ""}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
