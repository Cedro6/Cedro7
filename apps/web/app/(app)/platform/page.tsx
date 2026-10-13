import { notFound } from "next/navigation";
import { listCompanies, listSignupLinks } from "@bos/core";
import { SignupLinkMaker } from "../../../components/SignupLinkMaker";
import { TYPE_TEXT } from "../../../lib/features";
import { zone } from "../../../lib/locale";
import { isPlatformAdmin } from "../../../lib/platform";
import { pool } from "../../../lib/pool";
import { requireSession } from "../../../lib/session";
import { cancelLink, resetOwnerTwoStep, suspendCompany } from "./actions";

const STATE = { open: ["Not used yet", "badge-info"], used: ["Used", "badge-ok"], expired: ["Expired or cancelled", "badge-muted"] } as const;

export default async function PlatformPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { ctx, membership } = await requireSession();
  const { error, notice } = await searchParams;
  if (!isPlatformAdmin(membership.userEmail)) notFound();
  const [companies, links] = await Promise.all([listCompanies(pool), listSignupLinks(pool)]);
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: zone() });
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">{companies.length} {companies.length === 1 ? "company" : "companies"} on the service</div>
          <h1>Platform</h1>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      {notice && !error && <p className="notice">{notice}</p>}
      <section className="glass panel">
        <h2 className="title">Invite a new company</h2>
        <p className="muted">Sign-up is by invitation. Each link lets one person create one company.</p>
        <SignupLinkMaker />
      </section>
      <section className="glass panel">
        <h2 className="title">Sign-up links</h2>
        {links.length === 0 ? (
          <p className="muted">None made yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="compact">
              <thead><tr><th>For</th><th>Made</th><th>Status</th><th>Company created</th><th /></tr></thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.id}>
                    <td>{l.note || "(no note)"}</td>
                    <td>{day.format(l.createdAt)}</td>
                    <td><span className={`badge ${STATE[l.state][1]}`}>{STATE[l.state][0]}</span>{l.state === "open" && <div className="muted">until {day.format(l.expiresAt)}</div>}</td>
                    <td>{l.companyName ?? "–"}</td>
                    <td className="num">
                      {l.state === "open" && (
                        <form action={cancelLink}>
                          <input type="hidden" name="id" value={l.id} />
                          <button type="submit" className="link-button">Cancel link</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="glass panel">
        <h2 className="title">Companies</h2>
        <p className="muted">Names and counts only. You cannot see inside another company from here.</p>
        <div className="table-wrap">
          <table className="compact">
            <thead><tr><th>Company</th><th>Kind</th><th>Joined</th><th className="num">People</th><th className="num">Orders</th><th>Last activity</th><th /></tr></thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id}>
                  <td className="strong">{c.name}{c.suspended && <> <span className="badge badge-bad">Suspended</span></>}</td>
                  <td>{TYPE_TEXT[c.businessType as keyof typeof TYPE_TEXT]?.name ?? c.businessType}</td>
                  <td>{day.format(c.createdAt)}</td>
                  <td className="num">{c.people}</td>
                  <td className="num">{c.orders}</td>
                  <td>{c.lastActivity ? day.format(c.lastActivity) : "None yet"}</td>
                  <td className="num">
                    {c.id !== ctx.orgId && (
                      <form action={suspendCompany}>
                        <input type="hidden" name="orgId" value={c.id} />
                        <input type="hidden" name="suspend" value={c.suspended ? "0" : "1"} />
                        <button type="submit" className="link-button">{c.suspended ? "Switch back on" : "Suspend"}</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="glass panel">
        <h2 className="title">Owner locked out of two-step verification</h2>
        <p className="muted">For an owner who has lost their phone and their recovery codes and has no other owner to ask. Check it really is them first: this removes the second lock from their login.</p>
        <form action={resetOwnerTwoStep} className="form-row bill-inline">
          <label className="field grow">
            <span>Their email</span>
            <input name="email" type="email" required maxLength={200} />
          </label>
          <button type="submit" className="btn btn-glass">Turn off their two-step</button>
        </form>
      </section>
    </>
  );
}
