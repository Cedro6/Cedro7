import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "./context";
import { ValidationError } from "./errors";
import {
  FEATURES,
  featureOn,
  featuresFor,
  isBusinessType,
  isFeature,
  NEEDS_STOCK,
  parseFeatures,
  effectiveFeatures,
  productOf,
  ADD_ONS,
  type BusinessType,
  type FeatureId,
} from "./features";
import { requirePermission } from "./permissions";

export type Settings = {
  businessType: BusinessType;
  /** Every switch, with dependencies applied: what the app will actually allow. */
  features: Record<FeatureId, boolean>;
};

function effective(stored: unknown, type: BusinessType = "distributor"): Record<FeatureId, boolean> {
  const set = effectiveFeatures(type, parseFeatures(stored));
  return Object.fromEntries(FEATURES.map((id) => [id, featureOn(set, id)])) as Record<FeatureId, boolean>;
}

/** Anyone in the company can read these; the screens need them to know what to show. */
export async function getSettings(ctx: Ctx): Promise<Settings> {
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<{ business_type: string; features: unknown }>(
      "select business_type, features from organizations where id = $1",
      [ctx.orgId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Company not found");
    const type = isBusinessType(row.business_type) ? row.business_type : "distributor";
    return { businessType: type, features: effective(row.features, type) };
  });
}

/** Choosing a type replaces every switch with that type's starting set. */
export async function setBusinessType(ctx: Ctx, type: string): Promise<Settings> {
  requirePermission(ctx, "settings.manage");
  if (!isBusinessType(type)) throw new ValidationError("businessType", "Choose one of the listed business types.");
  const features = featuresFor(type);
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const before = await tx.query<{ business_type: string; features: unknown }>(
      "select business_type, features from organizations where id = $1 for update",
      [ctx.orgId],
    );
    // A product is a membership, not a setting: nobody moves a company into or out of Dealer Terminal from here.
    const was = before.rows[0]?.business_type;
    if (productOf(type) === "dealer" || (isBusinessType(was ?? "") && productOf(was as BusinessType) === "dealer")) {
      throw new ValidationError("businessType", "Dealer Terminal is a separate membership. Contact support to change the product.");
    }
    await tx.query("update organizations set business_type = $2, features = $3, updated_at = now() where id = $1", [
      ctx.orgId,
      type,
      JSON.stringify(features),
    ]);
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, before, after)
       values ($1, 'user', $2, 'settings.business_type_changed', 'organization', $1, $3, $4)`,
      [
        ctx.orgId,
        ctx.userId,
        JSON.stringify({ businessType: before.rows[0]?.business_type, features: before.rows[0]?.features }),
        JSON.stringify({ businessType: type, features }),
      ],
    );
    return { businessType: type, features: effective(features) };
  });
}

/** Turns one feature on or off. A feature that needs stock cannot be turned on while stock is off. */
export async function setFeature(ctx: Ctx, feature: string, on: boolean): Promise<Settings> {
  requirePermission(ctx, "settings.manage");
  if (!isFeature(feature)) throw new ValidationError("feature", "That is not a feature of this product.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const current = await tx.query<{ business_type: string; features: unknown }>(
      "select business_type, features from organizations where id = $1 for update",
      [ctx.orgId],
    );
    const row = current.rows[0];
    if (!row) throw new Error("Company not found");
    const stored = parseFeatures(row.features);
    if (isBusinessType(row.business_type) && productOf(row.business_type) === "dealer") throw new ValidationError("feature", "Dealer Terminal's tools are set by the membership.");
    if (ADD_ONS.includes(feature)) throw new ValidationError("feature", "That is part of a separate membership, not a switch.");
    if (on && NEEDS_STOCK.includes(feature) && stored.stock === false) {
      throw new ValidationError("feature", "Turn on Stock and shipping first.");
    }
    const next = { ...stored, [feature]: on };
    await tx.query("update organizations set features = $2, updated_at = now() where id = $1", [
      ctx.orgId,
      JSON.stringify(next),
    ]);
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, before, after)
       values ($1, 'user', $2, 'settings.feature_changed', 'organization', $1, $3, $4)`,
      [ctx.orgId, ctx.userId, JSON.stringify({ [feature]: featureOn(stored, feature) }), JSON.stringify({ [feature]: on })],
    );
    return { businessType: isBusinessType(row.business_type) ? row.business_type : "distributor", features: effective(next) };
  });
}
