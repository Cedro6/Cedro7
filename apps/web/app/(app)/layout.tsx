import type { ReactNode } from "react";
import { Sidebar } from "../../components/Sidebar";
import { initials } from "../../lib/format";
import { requireSession } from "../../lib/session";
import { signOut } from "./actions";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { membership } = await requireSession();
  return (
    <div className="shell">
      <Sidebar
        footer={
          <div className="account">
            <span className="avatar" aria-hidden="true">
              {initials(membership.userName)}
            </span>
            <div className="account-text">
              <div className="account-name">{membership.userName}</div>
              <div className="muted">
                {membership.orgName} · {membership.role}
              </div>
            </div>
            <form action={signOut}>
              <button type="submit" className="link-button">
                Sign out
              </button>
            </form>
          </div>
        }
      />
      <main className="content">{children}</main>
    </div>
  );
}
