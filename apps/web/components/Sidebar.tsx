"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  CalendarIcon,
  CustomersIcon,
  HomeIcon,
  ProductsIcon,
  InvoicesIcon,
  PurchasingIcon,
  ReportsIcon,
  SalesIcon,
} from "./icons";

const ICONS: Record<string, ReactNode> = {
  "/": <HomeIcon />,
  "/customers": <CustomersIcon />,
  "/products": <ProductsIcon />,
  "/sales": <SalesIcon />,
  "/invoices": <InvoicesIcon />,
  "/purchasing": <PurchasingIcon />,
  "/calendar": <CalendarIcon />,
  "/reports": <ReportsIcon />,
};

/** One entry per screen this person may open. The server decides the list from their role and the company's features. */
export type NavItem = { href: string; label: string; count?: number };

export function Sidebar({ items, company, footer }: { items: NavItem[]; company: string; footer: ReactNode }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="glass sidebar">
      <div className="brand">
        <span>
          Cedro Terminal
          <small>{company}</small>
        </span>
      </div>
      <div className="nav">
        {items.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className="nav-link" aria-current={active ? "page" : undefined}>
              {ICONS[item.href]}
              <span>{item.label}</span>
              {item.count ? <span className="nav-count">{item.count}</span> : null}
            </Link>
          );
        })}
      </div>
      {footer}
    </nav>
  );
}
