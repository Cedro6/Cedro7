import type { BusinessType, FeatureId } from "@bos/core";

/** The words people see for each feature and business type. The rules live in @bos/core. */
export const FEATURE_TEXT: Record<FeatureId, { name: string; about: string }> = {
  stock: { name: "Stock and shipping", about: "Count what is on hand, reserve it for orders, ship in parts and backorder what is short" },
  activity: { name: "Customer activity log", about: "Log calls, emails, meetings and visits, and see the last contact with each customer" },
  board: { name: "Sales board and quote tracking", about: "See every order by stage, mark quotes as lost with a reason, and track the win rate" },
  calendar: { name: "Calendar and reminders", about: "Reminders, order dates and expected deliveries on a month view" },
  purchasing: { name: "Purchasing and suppliers", about: "Purchase orders, approvals, receiving and reorder suggestions" },
  picking: { name: "Pick lists and packing slips", about: "Shelf-sorted pick lists before shipping and a packing slip for each shipment" },
  returns: { name: "Customer returns", about: "Take goods back, restock them and record the credit" },
  warehouse: { name: "Warehouse screen", about: "One place for the picking queue, barcode lookup and deliveries on the way" },
  putaway: { name: "Putaway", about: "A checklist for moving received stock from the dock to its shelves" },
  counts: { name: "Stock counts", about: "Count an aisle or category and correct the stock from the differences" },
  reports: { name: "Reports and sales charts", about: "Sales, margin, top products and customers, money owed and stock value" },
  expenses: { name: "Bills and expenses", about: "Record supplier bills and running costs, see what you owe and what the business really made" },
};

/** Features that change something you can see in this build. The rest can be switched, but their screens come later. */
export const BUILT: readonly FeatureId[] = ["stock", "purchasing", "calendar", "reports", "expenses", "returns"];

export const TYPE_TEXT: Record<BusinessType, { name: string; about: string }> = {
  distributor: { name: "Wholesale distributor", about: "Buys in bulk, stores it and ships to business customers. Everything is on." },
  retail: { name: "Retail", about: "Sells from a shop floor. Stock, reordering, counts and returns, without picking or putaway." },
  warehouse: { name: "Warehouse", about: "Stores and moves goods for others. Receiving, putaway, picking and counts, without the selling tools." },
  sales: { name: "Sales", about: "A sales team or agency. Customer contact, quotes and follow-ups, without warehouse work." },
  contractor: { name: "Contractor", about: "Quotes jobs and buys materials for them. Customers, quotes, reminders and purchasing, no warehouse." },
};
