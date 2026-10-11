export {
  createProduct,
  getProduct,
  listArchivedProducts,
  listProducts,
  productStatus,
  setProductArchived,
  updateProduct,
  type ProductInput,
  type ProductSummary,
} from "./catalog/products";
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
  createInvoice,
  customerStatement,
  getInvoice,
  listInvoices,
  PAYMENT_METHODS,
  raiseCredit,
  recordPayment,
  requestDeposit,
  termsDays,
  useCustomerCredit,
  voidInvoice,
  type AppliedCredit,
  type InvoiceDetail,
  type InvoiceKind,
  type InvoiceLine,
  type InvoiceState,
  type InvoiceSummary,
  type Payment,
  type Statement,
} from "./billing/invoices";
export {
  createCustomer,
  getCustomer,
  listCustomers,
  type Contact,
  type CustomerDetail,
  type CustomerSummary,
} from "./crm/customers";
export {
  customerStatus,
  listArchivedCustomers,
  removeContact,
  saveContact,
  setCustomerArchived,
  updateCustomer,
  type ContactInput,
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
export { attention, salesTrend, type AttentionItem, type SalesTrend } from "./platform/home";
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
  createPriceList,
  deletePriceList,
  listPriceLists,
  pricesForCustomer,
  setCustomerPriceList,
  type PriceList,
} from "./sales/pricing";
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
export { getSupplier, listArchivedSuppliers, setSupplierArchived, updateSupplier } from "./purchasing/orders";
