import { redirect } from "next/navigation";
import { can, IMPORT_COLUMNS, type ImportKind } from "@bos/core";
import { ImportTool } from "../../../components/ImportTool";
import { requireSession } from "../../../lib/session";

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { ctx, membership } = await requireSession();
  const allowed: { key: ImportKind; label: string; listHref: string }[] = [
    ...(can(ctx, "customer.write") ? [{ key: "customers" as const, label: "Customers", listHref: "/customers" }] : []),
    ...(can(ctx, "product.write") ? [{ key: "products" as const, label: "Products", listHref: "/products" }] : []),
    ...(can(ctx, "purchase_order.write") ? [{ key: "suppliers" as const, label: "Suppliers", listHref: "/purchasing" }] : []),
    ...(can(ctx, "invoice.write") ? [{ key: "invoices" as const, label: "Unpaid invoices", listHref: "/invoices?show=open" }] : []),
  ];
  if (allowed.length === 0) redirect("/");
  const asked = (await searchParams).kind;
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">{membership.orgName}</div>
          <h1>Import from a spreadsheet</h1>
        </div>
      </header>
      <ImportTool
        start={allowed.find((k) => k.key === asked)?.key ?? allowed[0]!.key}
        kinds={allowed.map((k) => ({ ...k, columns: IMPORT_COLUMNS[k.key].map((c) => ({ label: c.label, required: Boolean(c.required) })) }))}
      />
    </>
  );
}
