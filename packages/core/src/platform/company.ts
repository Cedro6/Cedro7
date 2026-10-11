import { withTenant } from "@bos/db/runtime";
import type { Ctx } from "./context";
import { ValidationError } from "./errors";
import { requirePermission } from "./permissions";

export type CompanyProfile = {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  taxNumber: string | null;
  invoiceFooter: string | null;
  /** A data URL for a PNG, JPEG or WebP image, or null. */
  logo: string | null;
};

const LOGO = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
/** About 200 KB of image once encoded. */
export const MAX_LOGO_LENGTH = 280_000;

const clean = (value: string | undefined, max: number, field: string, label: string): string | null => {
  const text = (value ?? "").trim();
  if (text.length > max) throw new ValidationError(field, `Keep the ${label} under ${max} characters.`);
  return text || null;
};

/** Anyone in the company can read this: it is what goes on the documents they print. */
export async function getCompanyProfile(ctx: Ctx): Promise<CompanyProfile> {
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<CompanyProfile>(
      `select name, address, phone, email, tax_number as "taxNumber", invoice_footer as "invoiceFooter", logo
         from organizations where id = $1`,
      [ctx.orgId],
    );
    if (!result.rows[0]) throw new Error("Company not found");
    return result.rows[0];
  });
}

export async function updateCompanyProfile(
  ctx: Ctx,
  input: { name: string; address?: string; phone?: string; email?: string; taxNumber?: string; invoiceFooter?: string },
): Promise<void> {
  requirePermission(ctx, "settings.manage");
  const name = input.name.trim();
  if (!name) throw new ValidationError("name", "Enter the company's name.");
  if (name.length > 200) throw new ValidationError("name", "Keep the name under 200 characters.");
  const email = clean(input.email, 200, "email", "email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("email", "Enter a valid email address.");
  const values = [
    name,
    clean(input.address, 500, "address", "address"),
    clean(input.phone, 50, "phone", "phone number"),
    email,
    clean(input.taxNumber, 60, "taxNumber", "tax number"),
    clean(input.invoiceFooter, 500, "invoiceFooter", "invoice footer"),
  ];
  await withTenant(ctx.pool, ctx.orgId, async (tx) => {
    await tx.query(
      "update organizations set name = $2, address = $3, phone = $4, email = $5, tax_number = $6, invoice_footer = $7, updated_at = now() where id = $1",
      [ctx.orgId, ...values],
    );
    await tx.query(
      `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
       values ($1, 'user', $2, 'company.updated', 'organization', $1, $3)`,
      [ctx.orgId, ctx.userId, JSON.stringify({ name })],
    );
  });
}

/** Sets the logo printed on invoices, or removes it when given null. Only PNG, JPEG and WebP are accepted. */
export async function setCompanyLogo(ctx: Ctx, dataUrl: string | null): Promise<void> {
  requirePermission(ctx, "settings.manage");
  if (dataUrl !== null) {
    if (dataUrl.length > MAX_LOGO_LENGTH) throw new ValidationError("logo", "That image is too large. Use one under 200 KB.");
    if (!LOGO.test(dataUrl)) throw new ValidationError("logo", "Use a PNG, JPEG or WebP image.");
  }
  await withTenant(ctx.pool, ctx.orgId, (tx) => tx.query("update organizations set logo = $2, updated_at = now() where id = $1", [ctx.orgId, dataUrl]));
}
