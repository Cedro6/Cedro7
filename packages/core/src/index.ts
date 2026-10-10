export { getProduct, listProducts, type ProductSummary } from "./catalog/products";
export {
  adjustStock,
  InsufficientStockError,
  listMovements,
  postMovements,
  reconcileStock,
  releaseForSourcesInTx,
  releaseReservation,
  reserveLinesInTx,
  reserveStock,
  shipReservedInTx,
  StockInputError,
  type Movement,
  type MovementKind,
  type StockMismatch,
} from "./inventory/ledger";
export {
  createCustomer,
  getCustomer,
  listCustomers,
  type Contact,
  type CustomerDetail,
  type CustomerSummary,
} from "./crm/customers";
export { currentMembership, membershipsByEmail, type Membership } from "./platform/auth";
export type { Ctx } from "./platform/context";
export { StateError, ValidationError } from "./platform/errors";
export {
  BUSINESS_TYPES,
  featureOn,
  FEATURES,
  featuresFor,
  isBusinessType,
  isFeature,
  NEEDS_STOCK,
  parseFeatures,
  TYPE_FEATURES,
  type BusinessType,
  type FeatureId,
  type FeatureSet,
} from "./platform/features";
export { getSettings, setBusinessType, setFeature, type Settings } from "./platform/settings";
export { overview, type Overview } from "./platform/overview";
export {
  can,
  ForbiddenError,
  isRole,
  PERMISSIONS,
  requirePermission,
  ROLES,
  type Actor,
  type Permission,
  type Role,
} from "./platform/permissions";
export {
  cancelOrder,
  confirmOrder,
  createQuote,
  getOrder,
  listOrders,
  reserveAvailable,
  shipOrder,
  type OrderDetail,
  type OrderLine,
  type OrderStatus,
  type OrderSummary,
  type Shipment,
} from "./sales/orders";
export {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  createPurchaseOrder,
  createSupplier,
  getPurchaseOrder,
  listPurchaseOrders,
  listSuppliers,
  markPurchaseOrderSent,
  receivePurchaseOrder,
  submitPurchaseOrder,
  type PurchaseOrderDetail,
  type PurchaseOrderLine,
  type PurchaseOrderStatus,
  type PurchaseOrderSummary,
  type Receipt,
  type Supplier,
} from "./purchasing/orders";
