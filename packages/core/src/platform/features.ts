/**
 * Features and business types. Customers, products, orders and invoices are always on.
 * Everything else is a switch the owner controls, and a business type is a starting set of switches.
 * A switch that is off removes the feature's permissions on the server, not only its screens.
 */
export const FEATURES = [
  "stock",
  "activity",
  "board",
  "calendar",
  "purchasing",
  "picking",
  "returns",
  "warehouse",
  "putaway",
  "counts",
  "reports",
  "expenses",
  "dealer",
] as const;
export type FeatureId = (typeof FEATURES)[number];

/** Stored per company. A missing key means on. */
export type FeatureSet = Partial<Record<FeatureId, boolean>>;

export const BUSINESS_TYPES = ["distributor", "retail", "warehouse", "sales", "contractor", "dealer"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/**
 * Products. Cedro Terminal is the business system, with a business type that sets the starting
 * switches. Dealer Terminal is a separate membership: its tools are fixed by the product, and a
 * company does not move between products from its own settings.
 */
export const PRODUCTS = ["cedro", "dealer"] as const;
export type Product = (typeof PRODUCTS)[number];
export const productOf = (type: BusinessType): Product => (type === "dealer" ? "dealer" : "cedro");
/** The business types a Cedro Terminal company may choose between. */
export const CEDRO_TYPES: readonly BusinessType[] = ["distributor", "retail", "warehouse", "sales", "contractor"];

/** What each business type starts with. */
export const TYPE_FEATURES: Record<BusinessType, readonly FeatureId[]> = {
  distributor: FEATURES.filter((f) => f !== "dealer"),
  retail: ["stock", "calendar", "purchasing", "returns", "counts", "reports", "expenses"],
  warehouse: ["stock", "purchasing", "picking", "returns", "warehouse", "putaway", "counts", "calendar"],
  sales: ["activity", "board", "calendar", "reports", "expenses"],
  contractor: ["activity", "board", "calendar", "purchasing", "reports", "expenses"],
  dealer: ["dealer", "activity", "calendar", "reports", "expenses"],
};

/** These do nothing unless stock is tracked, so they count as off while "stock" is off. */
export const NEEDS_STOCK: readonly FeatureId[] = ["picking", "warehouse", "putaway", "counts"];

export function isFeature(value: string): value is FeatureId {
  return (FEATURES as readonly string[]).includes(value);
}

export function isBusinessType(value: string): value is BusinessType {
  return (BUSINESS_TYPES as readonly string[]).includes(value);
}

/** Add-ons are off until a company switches them on, unlike the core features, which are on unless switched off. */
export const ADD_ONS: readonly FeatureId[] = ["dealer"];

export function featureOn(features: FeatureSet | undefined, id: FeatureId): boolean {
  if (ADD_ONS.includes(id)) return features?.[id] === true;
  if (!features) return true;
  if (features[id] === false) return false;
  return !NEEDS_STOCK.includes(id) || features.stock !== false;
}

/** The full set of switches a business type starts with. */
export function featuresFor(type: BusinessType): Record<FeatureId, boolean> {
  const on = TYPE_FEATURES[type];
  return Object.fromEntries(FEATURES.map((id) => [id, on.includes(id)])) as Record<FeatureId, boolean>;
}

/** The switches that apply: a Dealer Terminal company's are fixed by the product, whatever is stored. */
export function effectiveFeatures(type: BusinessType, stored: FeatureSet): FeatureSet {
  return productOf(type) === "dealer" ? featuresFor("dealer") : { ...stored, dealer: false };
}

/** Reads whatever is stored and keeps only known switches with true or false values. */
export function parseFeatures(stored: unknown): FeatureSet {
  if (!stored || typeof stored !== "object") return {};
  const out: FeatureSet = {};
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (isFeature(key) && typeof value === "boolean") out[key] = value;
  }
  return out;
}
