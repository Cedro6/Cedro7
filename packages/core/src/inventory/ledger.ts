import { withTenant, type PoolClient } from "@bos/db/runtime";
import type { Ctx } from "../platform/context";
import { requirePermission } from "../platform/permissions";

/**
 * The stock ledger. This is the only module that writes stock_levels,
 * stock_movements and stock_reservations. Rules it keeps:
 *  - a balance changes only in the same transaction as a ledger entry or reservation;
 *  - balance rows are locked in product-id order, so two postings cannot deadlock;
 *  - on-hand never goes below zero, and never below what is reserved;
 *  - a repeated request (same idempotency key) is applied once.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InsufficientStockError extends Error {
  constructor(
    public readonly productId: string,
    public readonly available: number,
    public readonly requested: number,
  ) {
    super(`Not enough stock: ${available} available, ${requested} needed.`);
    this.name = "InsufficientStockError";
  }
}

export class StockInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockInputError";
  }
}

export type MovementKind =
  | "opening_balance"
  | "adjustment"
  | "receipt"
  | "shipment"
  | "return_in"
  | "return_out"
  | "transfer_in"
  | "transfer_out";

export type MovementLine = { productId: string; qtyDelta: number; unitCost?: number | null };

export type Movement = {
  id: string;
  kind: MovementKind;
  qtyDelta: number;
  reason: string | null;
  postedAt: Date;
  postedBy: string | null;
};

type Level = { onHand: number; reserved: number };

function checkQuantity(value: number, what: string): void {
  if (!Number.isFinite(value) || value === 0) throw new StockInputError(`${what} must be a number other than zero.`);
  if (Math.abs(value) > 1e9) throw new StockInputError(`${what} is too large.`);
  if (Math.round(value * 1e4) !== value * 1e4) throw new StockInputError(`${what} allows at most 4 decimal places.`);
}

async function defaultLocation(tx: PoolClient): Promise<string> {
  const found = await tx.query<{ id: string }>(
    "select id from locations where is_active order by created_at, id limit 1",
  );
  const row = found.rows[0];
  if (!row) throw new StockInputError("This company has no warehouse set up yet.");
  return row.id;
}

/** Locks the balance rows for these products, creating zero rows where needed. Always in product-id order. */
async function lockLevels(
  tx: PoolClient,
  orgId: string,
  locationId: string,
  productIds: string[],
): Promise<Map<string, Level>> {
  const ids = [...new Set(productIds)].sort();
  if (ids.some((id) => !UUID.test(id))) throw new StockInputError("Unknown product.");
  const known = await tx.query("select 1 from products where id = any($1::uuid[])", [ids]);
  if (known.rowCount !== ids.length) throw new StockInputError("Unknown product.");
  await tx.query(
    `insert into stock_levels (org_id, product_id, location_id)
     select $1, id, $2 from unnest($3::uuid[]) as id order by id
     on conflict do nothing`,
    [orgId, locationId, ids],
  );
  const locked = await tx.query<{ product_id: string; on_hand: number; reserved: number }>(
    `select product_id, on_hand::float8 as on_hand, reserved::float8 as reserved
     from stock_levels
     where location_id = $1 and product_id = any($2::uuid[])
     order by product_id
     for update`,
    [locationId, ids],
  );
  return new Map(locked.rows.map((row) => [row.product_id, { onHand: row.on_hand, reserved: row.reserved }]));
}

/**
 * Posts ledger entries and updates balances in one transaction. Callers check
 * permissions; this function enforces the stock rules. Returns replayed: true
 * when the idempotency key was already used, in which case nothing changes.
 */
export async function postMovements(
  tx: PoolClient,
  ctx: Ctx,
  input: {
    idempotencyKey: string;
    kind: MovementKind;
    lines: MovementLine[];
    reason?: string | null;
    source?: { type: string; id: string };
    locationId?: string;
  },
): Promise<{ replayed: boolean }> {
  if (!input.idempotencyKey.trim()) throw new StockInputError("An idempotency key is required.");
  if (input.lines.length === 0) throw new StockInputError("Nothing to post.");
  for (const line of input.lines) checkQuantity(line.qtyDelta, "Quantity");

  const locationId = input.locationId ?? (await defaultLocation(tx));
  const levels = await lockLevels(
    tx,
    ctx.orgId,
    locationId,
    input.lines.map((line) => line.productId),
  );

  // Checked after the lock, so a concurrent retry of the same request waits here and then sees the first one.
  const already = await tx.query("select 1 from stock_movements where idempotency_key like $1 || ':%' limit 1", [
    input.idempotencyKey.replace(/[\\%_]/g, "\\$&"),
  ]);
  if (already.rowCount) return { replayed: true };

  const totals = new Map<string, number>();
  for (const line of input.lines) totals.set(line.productId, (totals.get(line.productId) ?? 0) + line.qtyDelta);
  for (const [productId, delta] of totals) {
    const level = levels.get(productId)!;
    const after = level.onHand + delta;
    if (after < 0 || after < level.reserved) {
      throw new InsufficientStockError(productId, level.onHand - level.reserved, -delta);
    }
  }

  for (const [productId, delta] of totals) {
    await tx.query(
      "update stock_levels set on_hand = on_hand + $1, updated_at = now() where product_id = $2 and location_id = $3",
      [delta, productId, locationId],
    );
  }
  for (const [index, line] of input.lines.entries()) {
    await tx.query(
      `insert into stock_movements
         (org_id, product_id, location_id, qty_delta, unit_cost, kind, reason, source_type, source_id, idempotency_key, posted_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        ctx.orgId,
        line.productId,
        locationId,
        line.qtyDelta,
        line.unitCost ?? null,
        input.kind,
        input.reason ?? null,
        input.source?.type ?? null,
        input.source?.id ?? null,
        `${input.idempotencyKey}:${index}`,
        ctx.userId,
      ],
    );
  }
  return { replayed: false };
}

/** A manual correction to on-hand stock, with a required reason and an audit entry. */
export async function adjustStock(
  ctx: Ctx,
  input: { productId: string; qtyDelta: number; reason: string; idempotencyKey: string },
): Promise<{ replayed: boolean }> {
  requirePermission(ctx.role, "stock.adjust");
  const reason = input.reason.trim();
  if (!reason) throw new StockInputError("Give a reason for the adjustment.");
  if (reason.length > 200) throw new StockInputError("Keep the reason under 200 characters.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await postMovements(tx, ctx, {
      idempotencyKey: `adjust:${input.idempotencyKey}`,
      kind: "adjustment",
      lines: [{ productId: input.productId, qtyDelta: input.qtyDelta }],
      reason,
    });
    if (!result.replayed) {
      await tx.query(
        `insert into audit_log (org_id, actor_type, actor_id, action, entity_type, entity_id, after)
         values ($1, 'user', $2, 'stock.adjusted', 'product', $3, $4)`,
        [ctx.orgId, ctx.userId, input.productId, JSON.stringify({ qtyDelta: input.qtyDelta, reason })],
      );
    }
    return result;
  });
}

/**
 * Sets stock aside for a document line. With partial: true it reserves what is
 * available (possibly nothing); otherwise it reserves the full quantity or fails.
 */
export async function reserveStock(
  ctx: Ctx,
  input: {
    productId: string;
    qty: number;
    source: { type: string; id: string };
    idempotencyKey: string;
    partial?: boolean;
  },
): Promise<{ reserved: number; reservationId: string | null; replayed: boolean }> {
  requirePermission(ctx.role, "stock.reserve");
  checkQuantity(input.qty, "Quantity");
  if (input.qty < 0) throw new StockInputError("Quantity must be positive.");
  if (!UUID.test(input.source.id)) throw new StockInputError("Unknown source document.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const locationId = await defaultLocation(tx);
    const level = (await lockLevels(tx, ctx.orgId, locationId, [input.productId])).get(input.productId)!;
    const existing = await tx.query<{ id: string; qty: number }>(
      "select id, qty::float8 as qty from stock_reservations where idempotency_key = $1",
      [input.idempotencyKey],
    );
    if (existing.rows[0]) {
      return { reserved: existing.rows[0].qty, reservationId: existing.rows[0].id, replayed: true };
    }
    const available = level.onHand - level.reserved;
    const qty = input.partial ? Math.min(input.qty, available) : input.qty;
    if (qty > available) throw new InsufficientStockError(input.productId, available, input.qty);
    if (qty <= 0) return { reserved: 0, reservationId: null, replayed: false };
    await tx.query(
      "update stock_levels set reserved = reserved + $1, updated_at = now() where product_id = $2 and location_id = $3",
      [qty, input.productId, locationId],
    );
    const created = await tx.query<{ id: string }>(
      `insert into stock_reservations
         (org_id, product_id, location_id, qty, source_type, source_id, idempotency_key, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [ctx.orgId, input.productId, locationId, qty, input.source.type, input.source.id, input.idempotencyKey, ctx.userId],
    );
    return { reserved: qty, reservationId: created.rows[0]!.id, replayed: false };
  });
}

/** Returns reserved stock to available. Releasing twice changes nothing the second time. */
export async function releaseReservation(ctx: Ctx, reservationId: string): Promise<{ released: number }> {
  requirePermission(ctx.role, "stock.reserve");
  if (!UUID.test(reservationId)) throw new StockInputError("Unknown reservation.");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const found = await tx.query<{ product_id: string; location_id: string }>(
      "select product_id, location_id from stock_reservations where id = $1",
      [reservationId],
    );
    const reservation = found.rows[0];
    if (!reservation) throw new StockInputError("Unknown reservation.");
    await lockLevels(tx, ctx.orgId, reservation.location_id, [reservation.product_id]);
    const released = await tx.query<{ qty: number }>(
      `update stock_reservations set status = 'released', updated_at = now()
       where id = $1 and status = 'open' returning qty::float8 as qty`,
      [reservationId],
    );
    const qty = released.rows[0]?.qty ?? 0;
    if (qty > 0) {
      await tx.query(
        "update stock_levels set reserved = reserved - $1, updated_at = now() where product_id = $2 and location_id = $3",
        [qty, reservation.product_id, reservation.location_id],
      );
    }
    return { released: qty };
  });
}

export async function listMovements(ctx: Ctx, productId: string, limit = 50): Promise<Movement[]> {
  requirePermission(ctx.role, "product.read");
  if (!UUID.test(productId)) return [];
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<Movement>(
      `select m.id, m.kind, m.qty_delta::float8 as "qtyDelta", m.reason, m.posted_at as "postedAt",
              u.name as "postedBy"
       from stock_movements m
       left join users u on u.id = m.posted_by
       where m.product_id = $1
       order by m.posted_at desc, m.id
       limit $2`,
      [productId, limit],
    );
    return result.rows;
  });
}

export type StockMismatch = {
  productId: string;
  onHand: number;
  ledgerTotal: number;
  reserved: number;
  openReservations: number;
};

/** Recomputes every balance from the ledger and open reservations. An empty list means the books agree. */
export async function reconcileStock(ctx: Ctx): Promise<StockMismatch[]> {
  requirePermission(ctx.role, "product.read");
  return withTenant(ctx.pool, ctx.orgId, async (tx) => {
    const result = await tx.query<StockMismatch>(
      `with keys as (
         select product_id, location_id from stock_levels
         union select product_id, location_id from stock_movements
         union select product_id, location_id from stock_reservations
       )
       select k.product_id as "productId",
              coalesce(l.on_hand, 0)::float8 as "onHand",
              coalesce(m.total, 0)::float8 as "ledgerTotal",
              coalesce(l.reserved, 0)::float8 as reserved,
              coalesce(r.total, 0)::float8 as "openReservations"
       from keys k
       left join stock_levels l using (product_id, location_id)
       left join (select product_id, location_id, sum(qty_delta) as total
                  from stock_movements group by 1, 2) m using (product_id, location_id)
       left join (select product_id, location_id, sum(qty) as total
                  from stock_reservations where status = 'open' group by 1, 2) r using (product_id, location_id)
       where coalesce(l.on_hand, 0) <> coalesce(m.total, 0)
          or coalesce(l.reserved, 0) <> coalesce(r.total, 0)`,
    );
    return result.rows;
  });
}
