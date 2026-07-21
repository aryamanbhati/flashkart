// The inventory engine — the production version of the oversell-demo crown jewel.
//
// Hot path (a buy) touches ONLY Redis, which is why it's fast enough for a sale.
// Mongo is touched exactly once per product: the first time it's bought, to prime
// the Redis counter. After that, every buy is a single atomic Lua call.

import mongoose from "mongoose";
import { redis } from "../db/redis.js";
import { ProductModel } from "../models/Product.js";
import { ReservationModel } from "../models/Reservation.js";
import { logger } from "../utils/logger.js";
import { publishStockUpdate } from "../realtime/stockChannel.js";

export const RESERVATION_TTL_MS = 90_000; // 90s to complete checkout

// --- the atomic script -----------------------------------------------------
// One unbreakable instruction: check-and-subtract-by-qty. Returns:
//    >= 0  -> success; the value is the NEW remaining stock
//    -1    -> sold out (not enough stock for this qty)
//    -2    -> not primed yet (key missing) — caller must prime from Mongo
const BUY_LUA = `
local stock = tonumber(redis.call('GET', KEYS[1]))
local qty = tonumber(ARGV[1])
if stock == nil then return -2 end
if stock < qty then return -1 end
return redis.call('DECRBY', KEYS[1], qty)
`;

redis.defineCommand("buyStock", { numberOfKeys: 1, lua: BUY_LUA });

// Teach TypeScript about the custom command we just registered.
interface InventoryCommands {
  buyStock(key: string, qty: number): Promise<number>;
}
const inv = redis as unknown as typeof redis & InventoryCommands;

const stockKey = (productId: string) => `stock:${productId}`;

export type PurchaseResult =
  | { status: "ok"; remaining: number }
  | { status: "sold_out" }
  | { status: "not_found" };

// Read the live stock (from Redis if primed, otherwise from Mongo catalog).
export async function getLiveStock(productId: string): Promise<number | null> {
  const fromRedis = await redis.get(stockKey(productId));
  if (fromRedis !== null) return Number(fromRedis);

  const product = await ProductModel.findById(productId).lean();
  return product ? product.stock : null;
}

// Copy Mongo's catalog stock onto the Redis whiteboard — but only if nobody has
// primed it yet. The `NX` ("set only if Not eXists") makes this atomic: if 500
// requests all discover the key is missing at once, only the FIRST SET wins, and
// the rest see the primed value. Without NX, a late primer could stomp over decrements
// that already happened and resurrect sold inventory.
async function primeFromMongo(productId: string): Promise<boolean> {
  const product = await ProductModel.findById(productId).lean();
  if (!product || !product.active) return false;

  const set = await redis.set(stockKey(productId), String(product.stock), "NX");
  if (set === "OK") {
    logger.debug({ productId, stock: product.stock }, "primed stock into redis");
  }
  return true;
}

export async function purchase(productId: string, qty: number): Promise<PurchaseResult> {
  let result = await inv.buyStock(stockKey(productId), qty);

  // -2 = key not primed. Load from Mongo (atomically, via NX) and retry once.
  if (result === -2) {
    const exists = await primeFromMongo(productId);
    if (!exists) return { status: "not_found" };
    result = await inv.buyStock(stockKey(productId), qty);
  }

  if (result === -2) return { status: "not_found" }; // still not primed = product gone
  if (result === -1) return { status: "sold_out" };
  void publishStockUpdate(productId, result, "purchase");
  return { status: "ok", remaining: result };
}

// --- reservation flow ------------------------------------------------------

export type ReserveResult =
  | { status: "held"; reservationId: string; expiresAt: Date; remaining: number }
  | { status: "sold_out" }
  | { status: "not_found" };

// Take stock out of the pool AND record a Reservation doc.
// If the Mongo write fails after we've decremented, we compensate by returning
// the stock — otherwise a Mongo blip would silently burn inventory.
export async function reserve(
  productId: string,
  qty: number,
  userId?: string,
): Promise<ReserveResult> {
  const purchased = await purchase(productId, qty);
  if (purchased.status !== "ok") return purchased;

  const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);
  try {
    const doc = await ReservationModel.create({
      productId: new mongoose.Types.ObjectId(productId),
      userId: userId ? new mongoose.Types.ObjectId(userId) : undefined,
      quantity: qty,
      status: "held",
      expiresAt,
    });
    // Overwrite the "purchase" event we just fired with the accurate "reserve"
    // reason so subscribers can distinguish held stock from confirmed sales.
    void publishStockUpdate(productId, purchased.remaining, "reserve");
    return {
      status: "held",
      reservationId: doc._id.toString(),
      expiresAt,
      remaining: purchased.remaining,
    };
  } catch (err) {
    // Compensate — the stock got decremented but the reservation record didn't land.
    await redis.incrby(stockKey(productId), qty);
    logger.error({ err, productId, qty }, "reserve: mongo write failed, returned stock");
    throw err;
  }
}

export type ConfirmResult =
  | { status: "confirmed"; productId: string; quantity: number }
  | { status: "expired" }
  | { status: "not_found" };

// Atomic status transition: held+not-expired -> confirmed. The compound predicate
// is what makes this race-safe against the sweeper — if the sweeper won, the
// {status:"held"} match fails and we return "expired".
export async function confirmReservation(reservationId: string): Promise<ConfirmResult> {
  if (!mongoose.isValidObjectId(reservationId)) return { status: "not_found" };

  const updated = await ReservationModel.findOneAndUpdate(
    { _id: reservationId, status: "held", expiresAt: { $gt: new Date() } },
    { $set: { status: "confirmed" } },
    { new: true },
  ).lean();

  if (updated) {
    return {
      status: "confirmed",
      productId: updated.productId.toString(),
      quantity: updated.quantity,
    };
  }

  // No match: either it never existed, or it's already been transitioned.
  const existing = await ReservationModel.findById(reservationId).lean();
  if (!existing) return { status: "not_found" };
  // Any non-"held" state at this point (expired/released/confirmed) is "too late".
  return { status: "expired" };
}

export type ReleaseResult =
  | { status: "released"; productId: string; quantity: number }
  | { status: "not_holdable" }
  | { status: "not_found" };

// User-initiated cancel. Same compare-and-set trick as confirm, but flips to
// "released" and returns stock. Idempotent-ish: calling twice returns not_holdable.
export async function releaseReservation(reservationId: string): Promise<ReleaseResult> {
  if (!mongoose.isValidObjectId(reservationId)) return { status: "not_found" };

  const updated = await ReservationModel.findOneAndUpdate(
    { _id: reservationId, status: "held" },
    { $set: { status: "released" } },
    { new: true },
  ).lean();

  if (!updated) {
    const existing = await ReservationModel.findById(reservationId).lean();
    if (!existing) return { status: "not_found" };
    return { status: "not_holdable" };
  }

  const newRemaining = await redis.incrby(
    stockKey(updated.productId.toString()),
    updated.quantity,
  );
  void publishStockUpdate(updated.productId.toString(), newRemaining, "release");
  return {
    status: "released",
    productId: updated.productId.toString(),
    quantity: updated.quantity,
  };
}

// Used by the sweeper. Returns the number of reservations actually reclaimed.
// The compare-and-set on {status:"held"} guarantees we never double-refund a
// reservation the user confirmed in the same millisecond.
export async function sweepExpiredReservations(): Promise<number> {
  const now = new Date();
  let reclaimed = 0;

  // Small batches so a big backlog doesn't stall the loop.
  for (let i = 0; i < 100; i++) {
    const doc = await ReservationModel.findOneAndUpdate(
      { status: "held", expiresAt: { $lte: now } },
      { $set: { status: "expired" } },
      { new: true },
    ).lean();
    if (!doc) break;
    await redis.incrby(stockKey(doc.productId.toString()), doc.quantity);
    reclaimed++;
  }

  return reclaimed;
}
