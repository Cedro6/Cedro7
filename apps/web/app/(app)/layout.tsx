import Link from "next/link";
import type { ReactNode } from "react";
import { isPlatformAdmin } from "../../lib/platform";
import { assistantUsage, can, expenseSummary, featureOn, getBriefing, overview } from "@bos/core";
import { Suspense } from "react";
import { Ava } from "../../components/Ava";
import { assistantConfigured, monthlyLimit } from "../../lib/assistant";
import { voiceConfigured } from "../../lib/voice";
import { Avatar } from "../../components/Avatar";
import { Main } from "../../components/Main";
import { ModeSwitch } from "../../components/ModeSwitch";
import { Sidebar, type NavItem } from "../../components/Sidebar";
import { requireSession } from "../../lib/session";
import { signOut } from "./actions";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { ctx, membership } = await requireSession({ setupAllowed: true });
  const counts = await overview(ctx);
  const stock = featureOn(ctx.features, "stock");
  // The menu lists only what this person may open and this company has switched on.
  const items: NavItem[] = [{ href: "/", label: "Home" }];
  if (can(ctx, "customer.read")) items.push({ href: "/customers", label: "Customers" });
  if (can(ctx, "product.read")) items.push({ href: "/products", label: "Products", count: stock ? (counts.lowStock ?? 0) : 0 });
  if (can(ctx, "sales_order.read")) items.push({ href: "/sales", label: "Sales", count: counts.readyToShip ?? 0 });
  if (can(ctx, "sales_order.read")) items.push({ href: "/invoices", label: "Invoices", count: counts.overdueInvoices ?? 0 });
  if (can(ctx, "purchase_order.read")) items.push({ href: "/purchasing", label: "Purchasing" });
  if (can(ctx, "expense.read")) items.push({ href: "/bills", label: "Bills", count: (await expenseSummary(ctx)).overdueCount });
  // Warehouse appears when at least one of its jobs is switched on and this person can do it.
  const warehouseJobs =
    stock &&
    ((featureOn(ctx.features, "picking") && can(ctx, "sales_order.ship")) ||
      (featureOn(ctx.features, "putaway") && can(ctx, "purchase_order.receive")) ||
      (featureOn(ctx.features, "counts") && can(ctx, "stock.adjust")) ||
      (featureOn(ctx.features, "warehouse") && can(ctx, "product.read")));
  if (warehouseJobs) items.push({ href: "/warehouse", label: "Warehouse" });
  if (featureOn(ctx.features, "calendar")) items.push({ href: "/calendar", label: "Calendar" });
  if (can(ctx, "report.view")) items.push({ href: "/reports", label: "Reports" });
  // Ava sits beside every screen rather than having a page of her own.
  const avaOn = assistantConfigured();
  const [usage, briefing] = await Promise.all([assistantUsage(ctx, monthlyLimit()), avaOn ? getBriefing(ctx) : null]);
  const role = membership.role[0]!.toUpperCase() + membership.role.slice(1);
  return (
    <div className="shell">
      <Sidebar
        items={items}
        company={membership.orgName}
        footer={
          <div className="account">
            <Avatar name={membership.userName} />
            <div className="account-text">
              <Link href="/account" className="account-name account-link">
                {membership.userName}
              </Link>
              <div className="muted">{role}</div>
            </div>
            <ModeSwitch />
            <div className="account-links">
              {can(ctx, "settings.manage") && <Link href="/settings">Settings</Link>}
              {isPlatformAdmin(membership.userEmail) && <Link href="/platform">Platform</Link>}
              <Link href="/account">Password</Link>
              {can(ctx, "settings.manage") && <Link href="/welcome">Setup guide</Link>}
              <form action={signOut}>
                <button type="submit">Sign out</button>
              </form>
            </div>
          </div>
        }
      />
      <Main>{children}</Main>
      <Suspense fallback={null}>
        <Ava
          firstName={membership.userName.split(" ")[0] || "there"}
          on={avaOn}
          left={Math.max(usage.limit - usage.questions, 0)}
          limit={usage.limit}
          voice={voiceConfigured()}
          briefing={briefing?.body ?? ""}
          abilities={{
            sales: can(ctx, "sales_order.write"),
            ship: can(ctx, "sales_order.ship"),
            stock: stock && can(ctx, "product.read"),
            reports: featureOn(ctx.features, "reports") && can(ctx, "report.view"),
            customers: can(ctx, "customer.write"),
            invoices: can(ctx, "sales_order.read"),
            calendar: featureOn(ctx.features, "calendar"),
          }}
        />
      </Suspense>
    </div>
  );
}
