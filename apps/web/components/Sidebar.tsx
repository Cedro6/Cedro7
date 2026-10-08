"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  CalendarIcon,
  CustomersIcon,
  HomeIcon,
  ProductsIcon,
  PurchasingIcon,
  ReportsIcon,
  SalesIcon,
} from "./icons";

const items: { href: string; label: string; icon: ReactNode }[] = [
  { href: "/", label: "Home", icon: <HomeIcon /> },
  { href: "/customers", label: "Customers", icon: <CustomersIcon /> },
  { href: "/products", label: "Products", icon: <ProductsIcon /> },
  { href: "/sales", label: "Sales", icon: <SalesIcon /> },
  { href: "/purchasing", label: "Purchasing", icon: <PurchasingIcon /> },
  { href: "/calendar", label: "Calendar", icon: <CalendarIcon /> },
  { href: "/reports", label: "Reports", icon: <ReportsIcon /> },
];

export function Sidebar({ footer }: { footer: ReactNode }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="glass sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <span />
        </span>
        BusinessOS
      </div>
      <div className="nav">
        {items.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className="nav-link" aria-current={active ? "page" : undefined}>
              {item.icon}
              {item.label}
            </Link>
          );
        })}
      </div>
      {footer}
    </nav>
  );
}
