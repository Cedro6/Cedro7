// Creates a few demo sales orders through the real service functions, so the
// demo company's stock, reservations and history are all consistent.
import { randomUUID } from "node:crypto";
import { appUrl, createPool } from "@bos/db/runtime";
import {
  confirmOrder,
  createQuote,
  listCustomers,
  listOrders,
  listProducts,
  membershipsByEmail,
  shipOrder,
  type Ctx,
} from "../src/index";

const pool = createPool(appUrl());
try {
  const amara = (await membershipsByEmail(pool, "amara@harborsupply.example"))[0];
  if (!amara) throw new Error("Run the seed first: pnpm db:seed");
  const ctx: Ctx = { pool, orgId: amara.orgId, userId: amara.userId, role: amara.role };
  if ((await listOrders(ctx)).length > 0) {
    console.log("Demo orders already exist.");
  } else {
    const customer = new Map((await listCustomers(ctx)).map((c) => [c.name, c.id]));
    const product = new Map((await listProducts(ctx)).map((p) => [p.sku, p.id]));
    const make = (name: string, lines: [string, number][], taxRatePercent = 6.25) =>
      createQuote(ctx, {
        customerId: customer.get(name)!,
        taxRatePercent,
        lines: lines.map(([sku, qty]) => ({ productId: product.get(sku)!, qty })),
      });

    const bayside = await make("Bayside Hardware", [
      ["FS-DS3-100", 40],
      ["GL-WK-L", 60],
      ["PL-CEM-16", 24],
      ["TL-UKB-50", 30],
    ]);
    await confirmOrder(ctx, bayside.id);
    await shipOrder(ctx, bayside.id, { idempotencyKey: randomUUID() });

    const delgado = await make("Delgado Restaurant Supply", [
      ["GL-WK-L", 120],
      ["TL-UKB-50", 20],
    ]);
    await confirmOrder(ctx, delgado.id);

    const tanaka = await make("Tanaka Garden Center", [
      ["GD-HOSE-50", 8],
      ["GD-NOZ-BR", 12],
      ["GD-SOIL-20", 6],
    ]);
    await confirmOrder(ctx, tanaka.id);

    await make("Kim & Sons Market", [["GD-SOIL-20", 20]]);
    console.log("Created 4 demo orders.");
  }
} finally {
  await pool.end();
}
