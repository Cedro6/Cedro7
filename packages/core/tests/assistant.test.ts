import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appUrl, createPool, migrate, ownerUrl, seed, type Pool } from "@bos/db";
import { ask, AssistantLimitError, assistantUsage, getBriefing, toolsFor, writeBriefing, type Ctx, type ModelCall, type ModelRequest, type Role } from "../src/index";

let owner: Pool;
let app: Pool;
let orgId: string;
let userId: string;
const as = (role: Role, features?: Ctx["features"]): Ctx => ({ pool: app, orgId, userId, role, features });
const who = { company: "Harbor Supply Co.", person: "Amara", monthlyLimit: 100 };
const usage = { input_tokens: 100, output_tokens: 20 };

/** A stand-in model: calls the named tools on its first turn, then answers with what came back. */
function scripted(calls: { name: string; input?: Record<string, unknown> }[]): { call: ModelCall; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const call: ModelCall = async (request) => {
    requests.push(structuredClone(request));
    if (requests.length === 1 && calls.length > 0) {
      return { stop_reason: "tool_use", usage, content: calls.map((c, i) => ({ type: "tool_use" as const, id: `t${i}`, name: c.name, input: c.input ?? {} })) };
    }
    const last = request.messages.at(-1)!;
    const seen = Array.isArray(last.content) ? last.content.map((b) => (b.type === "tool_result" ? b.content : "")).join(" | ") : "";
    return { stop_reason: "end_turn", usage, content: [{ type: "text", text: `ANSWER ${seen}` }] };
  };
  return { call, requests };
}

beforeAll(async () => {
  owner = createPool(ownerUrl());
  app = createPool(appUrl());
  await owner.query("drop schema public cascade; create schema public;");
  await migrate(owner);
  ({ orgId, userId } = await seed(owner));
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

describe("assistant", () => {
  it("runs the lookups the model asks for and returns its answer with real records", async () => {
    const model = scripted([{ name: "find_customers", input: { search: "Bayside" } }]);
    const answer = await ask(as("owner"), { ...who, question: "Who is Bayside?" }, model.call);
    expect(answer.lookups).toEqual(["find_customers"]);
    expect(answer.text).toContain("Bayside Hardware");
    expect(answer.text).toContain("/customers/");
    expect(model.requests[0]!.system).toContain("You never change anything yourself");
  });

  it("offers only the lookups the role and features allow", async () => {
    const names = (ctx: Ctx) => toolsFor(ctx).map((t) => t.name);
    expect(names(as("owner"))).toContain("sales_report");
    expect(names(as("warehouse"))).not.toContain("find_customers");
    expect(names(as("owner", { purchasing: false, reports: false }))).not.toEqual(expect.arrayContaining(["list_purchase_orders", "sales_report"]));
    const model = scripted([]);
    await ask(as("viewer"), { ...who, question: "hi" }, model.call);
    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual(names(as("viewer")));
  });

  it("refuses a lookup the person is not offered, even if the model asks for it", async () => {
    const model = scripted([{ name: "find_customers" }]);
    const answer = await ask(as("warehouse"), { ...who, question: "List customers" }, model.call);
    expect(answer.text).toContain("not available to this person");
    expect(answer.text).not.toContain("Bayside");
    expect(answer.lookups).toEqual([]);
  });

  it("never shows cost to a role that cannot see it", async () => {
    const model = scripted([{ name: "find_products" }]);
    expect((await ask(as("sales"), { ...who, question: "products" }, model.call)).text).not.toContain('"cost"');
    expect((await ask(as("owner"), { ...who, question: "products" }, scripted([{ name: "find_products" }]).call)).text).toContain('"cost"');
  });

  it("has no tool that changes anything", async () => {
    const counts = () => owner.query("select (select count(*) from customers) + (select count(*) from products) + (select count(*) from sales_orders) + (select count(*) from stock_movements) + (select count(*) from invoices) + (select count(*) from audit_log) as n");
    const before = (await counts()).rows[0].n;
    for (const tool of toolsFor(as("owner"))) await tool.run(as("owner"), {});
    expect((await counts()).rows[0].n).toBe(before);
  });

  it("counts questions and tokens, and stops at the monthly limit without calling the model", async () => {
    await owner.query("delete from assistant_usage");
    const model = scripted([]);
    await ask(as("owner"), { ...who, monthlyLimit: 2, question: "one" }, model.call);
    await ask(as("owner"), { ...who, monthlyLimit: 2, question: "two" }, model.call);
    await expect(ask(as("owner"), { ...who, monthlyLimit: 2, question: "three" }, model.call)).rejects.toBeInstanceOf(AssistantLimitError);
    expect(model.requests).toHaveLength(2);
    expect(await assistantUsage(as("owner"), 2)).toEqual({ questions: 2, limit: 2, inputTokens: 200, outputTokens: 40 });
  });

  it("stops after five rounds even if the model keeps asking for lookups", async () => {
    let n = 0;
    const greedy: ModelCall = async (request) => {
      n++;
      return request.tools.length > 0
        ? { stop_reason: "tool_use", usage, content: [{ type: "tool_use", id: `t${n}`, name: "needs_attention", input: {} }] }
        : { stop_reason: "end_turn", usage, content: [{ type: "text", text: "done" }] };
    };
    const answer = await ask(as("owner"), { ...who, question: "loop" }, greedy);
    expect(n).toBe(5);
    expect(answer.text).toBe("done");
  });

  it("writes a briefing once for the day, read-only, per person", async () => {
    expect(await getBriefing(as("owner"))).toBeNull();
    const model = scripted([{ name: "needs_attention" }]);
    const first = await writeBriefing(as("owner"), who, model.call);
    expect(first.body).toContain("ANSWER");
    expect(model.requests[0]!.tools.some((t) => t.name.startsWith("propose_"))).toBe(false);
    expect(model.requests[0]!.system).toContain("You can only read");
    expect((await getBriefing(as("owner")))!.body).toBe(first.body);
    const again = await writeBriefing(as("owner"), who, scripted([]).call);
    expect((await getBriefing(as("owner")))!.body).toBe(again.body);
    expect((await owner.query("select count(*)::int as n from assistant_briefings")).rows[0].n).toBe(1);
    await owner.query("update assistant_briefings set day = day - 1");
    expect(await getBriefing(as("owner"))).toBeNull(); // yesterday's is not shown today
  });
});
