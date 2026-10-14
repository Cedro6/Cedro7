import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "../platform/context";
import { featureOn } from "../platform/features";
import { requirePermission } from "../platform/permissions";
import type { DealPayment } from "./deals";
import { cashReport } from "./operations";

/**
 * What needs the dealer today, for Ava and the briefing: money still owed on open deals, deals paid
 * but not delivered, paperwork gaps that stop a sale, cars that have sat too long, and drafts nobody
 * finished. Each item links the one record it is about.
 */
export type DealerAttention = { kind: string; title: string; detail: string; link: string };

export async function dealerAttention(ctx: Ctx): Promise<DealerAttention[]> {
  requirePermission(ctx, "vehicle.read");
  if (!featureOn(ctx.features, "dealer")) return [];
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const deals = await tx.query<{ id: string; number: string; buyer: string; car: string; total: number; paid: number; days: number; missing: string[] }>(
      `select d.id, d.number, d.buyer_name as buyer, concat_ws(' ', v.year::text, v.make, v.model) as car,
              (greatest(d.sale_price + d.dealer_fee - d.trade_allowance, 0) * (1 + d.state_tax_pct / 100)
                + least(greatest(d.sale_price + d.dealer_fee - d.trade_allowance, 0), d.surtax_cap) * d.surtax_pct / 100
                + d.tag_title_fees + d.other_fees)::float8 as total,
              coalesce((select sum(p.amount) from deal_payments p where p.deal_id = d.id), 0)::float8 as paid,
              extract(day from now() - d.created_at)::int as days,
              array_remove(array[
                case when d.buyer_address is null or d.buyer_city is null or d.buyer_zip is null then 'buyer''s address' end,
                case when d.buyer_dl is null then 'licence number' end,
                case when d.odometer is null then 'odometer reading' end,
                case when v.title_number is null then 'title number' end
              ], null) as missing
         from deals d join vehicles v on v.org_id = d.org_id and v.id = d.vehicle_id
        where d.status = 'open'
        order by d.created_at`,
    );
    const items: DealerAttention[] = [];
    for (const d of deals.rows) {
      const owed = Math.round((d.total - d.paid) * 100) / 100;
      if (owed > 0.005) {
        items.push({ kind: "deal_owed", title: `${d.number}: ${owed.toFixed(2)} still owed`, detail: `${d.buyer} on the ${d.car}, open ${d.days} ${d.days === 1 ? "day" : "days"}${d.paid > 0 ? `, ${d.paid.toFixed(2)} paid so far` : ", nothing paid yet"}`, link: `/deals/${d.id}` });
      } else {
        items.push({ kind: "deal_ready", title: `${d.number}: paid in full, not delivered`, detail: `${d.buyer} on the ${d.car}${d.missing.length ? `; still missing ${d.missing.join(", ")}` : "; ready to deliver"}`, link: `/deals/${d.id}` });
        continue;
      }
      if (d.missing.length) items.push({ kind: "deal_paperwork", title: `${d.number}: paperwork incomplete`, detail: `Missing ${d.missing.join(", ")} for the title forms`, link: `/deals/${d.id}` });
    }
    // After the sale: the IRS cash report, the temp tag, the title application and the signed papers.
    const after = await tx.query<{ id: string; number: string; buyer: string; status: string; delivered: string | null; filed: string | null; tag: string | null; expires: string | null; sent: string | null; done: string | null; days: number | null; signed: number; payments: DealPayment[] }>(
      `select d.id, d.number, d.buyer_name as buyer, d.status, to_char(d.delivered_on, 'YYYY-MM-DD') as delivered, to_char(d.form_8300_filed_on, 'YYYY-MM-DD') as filed,
              d.temp_tag_number as tag, to_char(d.temp_tag_expires_on, 'YYYY-MM-DD') as expires, to_char(d.title_sent_on, 'YYYY-MM-DD') as sent,
              to_char(d.title_done_on, 'YYYY-MM-DD') as done, (current_date - d.delivered_on)::int as days,
              (select count(*)::int from dealer_files f where f.deal_id = d.id and f.kind = 'signed_form') as signed,
              coalesce((select json_agg(json_build_object('id', p.id, 'amount', p.amount::float8, 'method', p.method, 'reference', p.reference, 'paidOn', to_char(p.paid_on, 'YYYY-MM-DD'), 'recordedBy', null))
                          from deal_payments p where p.deal_id = d.id), '[]') as payments
         from deals d
        where d.status = 'open' or (d.status = 'delivered' and (d.title_done_on is null or d.form_8300_filed_on is null or d.delivered_on > current_date - 60))
        order by d.created_at`,
    );
    const today = new Date().toISOString().slice(0, 10);
    const plus = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    for (const d of after.rows) {
      const cash = cashReport(d.payments);
      if (cash.required && !d.filed) {
        items.push({ kind: "form_8300", title: `${d.number}: Form 8300 ${cash.dueOn! < today ? "is overdue" : `due by ${cash.dueOn}`}`, detail: `${d.buyer} paid ${cash.total.toFixed(2)} in cash or cash-like payments. File it with the IRS, then record the date on the deal`, link: `/deals/${d.id}` });
      }
      if (d.status !== "delivered") continue;
      if (!d.done && d.tag && d.expires && d.expires <= plus(today, 5)) {
        items.push({ kind: "temp_tag", title: `${d.number}: temp tag ${d.tag} ${d.expires < today ? "has expired" : `expires ${d.expires}`}`, detail: `${d.buyer}${d.sent ? `. Title application went in on ${d.sent}` : ". The title application has not gone in yet"}`, link: `/deals/${d.id}` });
      }
      if (!d.sent && d.delivered && (d.days ?? 0) >= 10) {
        items.push({ kind: "title_due", title: `${d.number}: title application due by ${plus(d.delivered, 30)}`, detail: `${d.buyer}, delivered ${d.days} days ago. Florida gives the dealer 30 days to apply for the buyer's title`, link: `/deals/${d.id}` });
      }
      if (d.signed === 0 && (d.days ?? 0) <= 60) {
        items.push({ kind: "papers_missing", title: `${d.number}: no signed paperwork kept`, detail: `${d.buyer}. Scan or photograph the signed forms and add them to the deal`, link: `/deals/${d.id}` });
      }
    }
    const cars = await tx.query<{ id: string; stock: string; car: string; status: string; days: number; asking: number | null; title: string | null }>(
      `select v.id, v.stock_number as stock, concat_ws(' ', v.year::text, v.make, v.model) as car, v.status,
              extract(day from now() - v.created_at)::int as days, v.asking_price::float8 as asking, v.title_number as title
         from vehicles v
        where v.status not in ('sold', 'removed')
          and not exists (select 1 from deals d where d.vehicle_id = v.id and d.status = 'open')
        order by v.created_at`,
    );
    for (const v of cars.rows) {
      const name = v.car.trim() || v.stock;
      if (v.status === "on_lot" && v.days >= 60) items.push({ kind: "car_aged", title: `${v.stock} has been here ${v.days} days`, detail: `${name}${v.asking ? `, asking ${v.asking.toFixed(2)}` : ""}. Worth a price review`, link: `/vehicles/${v.id}` });
      else if (v.status === "on_lot" && v.asking === null) items.push({ kind: "car_no_price", title: `${v.stock} is on the lot with no asking price`, detail: name, link: `/vehicles/${v.id}` });
      else if (v.status === "draft" && v.days >= 3) items.push({ kind: "car_draft", title: `${v.stock} is still a draft after ${v.days} days`, detail: `${name}. Finish it and put it on the lot or into recon`, link: `/vehicles/${v.id}` });
      else if (v.status === "recon" && v.days >= 21) items.push({ kind: "car_recon", title: `${v.stock} has been in reconditioning ${v.days} days`, detail: name, link: `/vehicles/${v.id}` });
      if (v.status === "on_lot" && v.title === null) items.push({ kind: "car_no_title", title: `${v.stock} has no title number recorded`, detail: `${name}. The title forms need it before it can be sold`, link: `/vehicles/${v.id}` });
    }
    return items;
  });
}
