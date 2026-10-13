"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  BillsIcon,
  CalendarIcon,
  CustomersIcon,
  HomeIcon,
  ProductsIcon,
  InvoicesIcon,
  PurchasingIcon,
  ReportsIcon,
  SearchIcon,
  SalesIcon,
  SettingsIcon,
  VehicleIcon,
  WarehouseIcon,
} from "./icons";

const ICONS: Record<string, ReactNode> = {
  "/": <HomeIcon />,
  "/customers": <CustomersIcon />,
  "/products": <ProductsIcon />,
  "/sales": <SalesIcon />,
  "/invoices": <InvoicesIcon />,
  "/purchasing": <PurchasingIcon />,
  "/bills": <BillsIcon />,
  "/warehouse": <WarehouseIcon />,
  "/calendar": <CalendarIcon />,
  "/reports": <ReportsIcon />,
  "/settings": <SettingsIcon />,
  "/vehicles": <VehicleIcon />,
};

/** One entry per screen this person may open. The server decides the list from their role and the company's features. */
export type NavItem = { href: string; label: string; count?: number; children?: { href: string; label: string }[] };

export function Sidebar({ items, company, product, footer }: { items: NavItem[]; company: string; product: "cedro" | "dealer"; footer: ReactNode }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="glass sidebar">
      <div className="brand">
        <span>
          {product === "dealer" ? "Dealer Terminal" : "Cedro Terminal"}
          <small>{company}</small>
        </span>
      </div>
      <form action="/search" className="side-search" role="search">
        <SearchIcon />
        <label htmlFor="side-q" className="sr-only">Search everything</label>
        <input id="side-q" name="q" type="search" placeholder="Search" maxLength={80} />
      </form>
      <div className="nav">
        {items.map((item) =>
          item.children?.length ? (
            <NavGroup key={item.href} item={item} pathname={pathname} />
          ) : (
            <NavLink key={item.href} item={item} active={item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)} />
          ),
        )}
      </div>
      {footer}
    </nav>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link href={item.href} className="nav-link" aria-current={active ? "page" : undefined}>
      {ICONS[item.href]}
      <span>{item.label}</span>
      {item.count ? <span className="nav-count">{item.count}</span> : null}
    </Link>
  );
}

/** A menu entry with a short list tucked under it, opened with the arrow. It opens by itself on any of its screens. */
function NavGroup({ item, pathname }: { item: NavItem; pathname: string }) {
  const inside = item.children!.some((c) => pathname.startsWith(c.href));
  const [open, setOpen] = useState(inside);
  useEffect(() => {
    if (inside) setOpen(true);
  }, [inside]);
  return (
    <>
      <div className="nav-group">
        <NavLink item={item} active={pathname.startsWith(item.href)} />
        <button type="button" className="nav-more" aria-expanded={open} aria-label={open ? `Hide more under ${item.label}` : `Show more under ${item.label}`} onClick={() => setOpen(!open)}>
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 8l5 5 5-5" /></svg>
        </button>
      </div>
      {open &&
        item.children!.map((child) => (
          <Link key={child.href} href={child.href} className="nav-link nav-sub" aria-current={pathname.startsWith(child.href) ? "page" : undefined}>
            <span>{child.label}</span>
          </Link>
        ))}
    </>
  );
}
