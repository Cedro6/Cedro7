export { listProducts, type ProductSummary } from "./catalog/products";
export {
  createCustomer,
  getCustomer,
  listCustomers,
  ValidationError,
  type Contact,
  type CustomerDetail,
  type CustomerSummary,
} from "./crm/customers";
export { currentMembership, membershipsByEmail, type Membership } from "./platform/auth";
export type { Ctx } from "./platform/context";
export { overview, type Overview } from "./platform/overview";
export {
  can,
  ForbiddenError,
  isRole,
  PERMISSIONS,
  requirePermission,
  ROLES,
  type Permission,
  type Role,
} from "./platform/permissions";
