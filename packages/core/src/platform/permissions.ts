import { featureOn, type FeatureId, type FeatureSet } from "./features";

export const ROLES = ["owner", "admin", "sales", "purchasing", "warehouse", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "customer.read",
  "customer.write",
  "product.read",
  "product.write",
  "product.cost.view",
  "stock.adjust",
  "stock.reserve",
  "sales_order.read",
  "sales_order.write",
  "sales_order.ship",
  "purchase_order.read",
  "purchase_order.write",
  "purchase_order.approve",
  "purchase_order.receive",
  "invoice.write",
  "report.view",
  "expense.read",
  "expense.write",
  "settings.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const everything: readonly Permission[] = PERMISSIONS;

/** Services check permission keys, never role names. This table is the only place roles are spelled out. */
const MATRIX: Record<Role, readonly Permission[]> = {
  owner: everything,
  admin: everything,
  sales: [
    "customer.read",
    "customer.write",
    "product.read",
    "stock.reserve",
    "sales_order.read",
    "sales_order.write",
    "report.view",
  ],
  purchasing: [
    "customer.read",
    "product.read",
    "product.write",
    "product.cost.view",
    "stock.adjust",
    "sales_order.read",
    "purchase_order.read",
    "purchase_order.write",
    "purchase_order.receive",
    "report.view",
    "expense.read",
    "expense.write",
  ],
  warehouse: [
    "product.read",
    "stock.adjust",
    "sales_order.read",
    "sales_order.ship",
    "purchase_order.read",
    "purchase_order.receive",
  ],
  viewer: ["customer.read", "product.read", "sales_order.read", "purchase_order.read", "report.view"],
};

export class ForbiddenError extends Error {
  constructor(public readonly permission: Permission) {
    super(`Not allowed: ${permission}`);
    this.name = "ForbiddenError";
  }
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** A permission that belongs to a feature is not held while that feature is switched off. */
const PERMISSION_FEATURE: Partial<Record<Permission, FeatureId>> = {
  "stock.adjust": "stock",
  "stock.reserve": "stock",
  "purchase_order.read": "purchasing",
  "purchase_order.write": "purchasing",
  "purchase_order.approve": "purchasing",
  "purchase_order.receive": "purchasing",
  "report.view": "reports",
  "expense.read": "expenses",
  "expense.write": "expenses",
};

/** Either a bare role, or the acting person with their company's feature switches. */
export type Actor = Role | { role: Role; features?: FeatureSet };

export function can(actor: Actor, permission: Permission): boolean {
  const role = typeof actor === "string" ? actor : actor.role;
  if (!MATRIX[role].includes(permission)) return false;
  const feature = PERMISSION_FEATURE[permission];
  if (!feature || typeof actor === "string") return true;
  return featureOn(actor.features, feature);
}

export function requirePermission(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) throw new ForbiddenError(permission);
}
