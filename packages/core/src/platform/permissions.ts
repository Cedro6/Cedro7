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
  "settings.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const everything: readonly Permission[] = PERMISSIONS;

/** Services check permission keys, never role names. This table is the only place roles are spelled out. */
const MATRIX: Record<Role, readonly Permission[]> = {
  owner: everything,
  admin: everything,
  sales: ["customer.read", "customer.write", "product.read", "stock.reserve", "sales_order.read", "sales_order.write"],
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
  ],
  warehouse: [
    "product.read",
    "stock.adjust",
    "sales_order.read",
    "sales_order.ship",
    "purchase_order.read",
    "purchase_order.receive",
  ],
  viewer: ["customer.read", "product.read", "sales_order.read", "purchase_order.read"],
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

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}

export function requirePermission(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new ForbiddenError(permission);
}
