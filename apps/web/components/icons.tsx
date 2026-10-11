import type { ReactNode } from "react";

function Icon({ children, width = 1.8 }: { children: ReactNode; width?: number }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const HomeIcon = () => <Icon><path d="M3 9l7-6 7 6v8H3z" /></Icon>;
export const CustomersIcon = () => <Icon><circle cx="10" cy="7" r="3" /><path d="M4 17c0-3.3 2.7-5 6-5s6 1.7 6 5" /></Icon>;
export const ProductsIcon = () => <Icon><path d="M3 6l7-3 7 3v8l-7 3-7-3zM3 6l7 3 7-3M10 9v8" /></Icon>;
export const SalesIcon = () => <Icon><path d="M5 3h7l4 4v10H5zM8 10h5M8 13h5" /></Icon>;
export const InvoicesIcon = () => <Icon><path d="M5 2h10v16l-2.5-1.5L10 18l-2.5-1.5L5 18zM8 7h4M8 10h4" /></Icon>;
export const PurchasingIcon = () => <Icon><path d="M2 5h10v9H2zM12 8h4l2 3v3h-6z" /></Icon>;
export const CalendarIcon = () => <Icon><path d="M3 5h14v12H3zM3 9h14M7 3v4M13 3v4" /></Icon>;
export const WarehouseIcon = () => <Icon><path d="M2 8l8-5 8 5v9H2zM6 17v-6h8v6M6 14h8" /></Icon>;
export const AssistantIcon = () => <Icon><path d="M10 2l1.8 4.7L16.5 8.5l-4.7 1.8L10 15l-1.8-4.7L3.5 8.5l4.7-1.8zM16 14v4M14 16h4" /></Icon>;
export const ReportsIcon = () => <Icon width={2}><path d="M4 16V9M10 16V4M16 16v-5" /></Icon>;
export const SearchIcon = () => <Icon width={2}><circle cx="9" cy="9" r="5.5" /><path d="M13.5 13.5L17 17" /></Icon>;
export const SparkIcon = ({ fill = "#0d0e0d" }: { fill?: string }) => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill={fill} aria-hidden="true">
    <path d="M10 2l1.9 5.1L17 9l-5.1 1.9L10 16l-1.9-5.1L3 9l5.1-1.9z" />
  </svg>
);
