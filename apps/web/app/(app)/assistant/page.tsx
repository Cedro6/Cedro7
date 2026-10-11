import { assistantUsage, can, featureOn } from "@bos/core";
import { AssistantChat } from "../../../components/AssistantChat";
import { assistantConfigured, monthlyLimit } from "../../../lib/assistant";
import { requireSession } from "../../../lib/session";

export default async function AssistantPage() {
  const { ctx } = await requireSession();
  const on = assistantConfigured();
  const usage = await assistantUsage(ctx, monthlyLimit());
  const left = Math.max(usage.limit - usage.questions, 0);
  // Example questions this person can actually get an answer to.
  const suggestions = [
    "What needs my attention today?",
    can(ctx, "sales_order.read") ? "Who owes us money, and how late is it?" : null,
    featureOn(ctx.features, "stock") && can(ctx, "product.read") ? "What should I reorder?" : null,
    featureOn(ctx.features, "reports") && can(ctx, "report.view") ? "How were sales in the last 30 days?" : null,
    can(ctx, "sales_order.write") ? "Make a quote for Bayside Hardware: 20 pairs of work gloves" : null,
    featureOn(ctx.features, "purchasing") && can(ctx, "purchase_order.write") ? "Draft a purchase order for what is running low" : null,
  ].filter((q): q is string => q !== null);
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">{on ? `${left} of ${usage.limit} questions left this month` : "Not switched on"}</div>
          <h1>Assistant</h1>
        </div>
      </header>
      {!on && (
        <section className="glass panel empty">
          <div className="empty-title">The assistant is not switched on yet</div>
          <p>It needs an Anthropic API key added to this site's settings. Until then nothing is sent anywhere and nothing is charged.</p>
        </section>
      )}
      <AssistantChat suggestions={suggestions} disabled={!on || left === 0} />
      <p className="muted footnote">
        The assistant reads your records to answer and can prepare changes for you. It sees and does only what your role allows, and nothing changes until you press Confirm. It cannot send email, take payments or delete anything.
      </p>
    </>
  );
}
