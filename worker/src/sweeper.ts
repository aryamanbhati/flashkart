// Reservation sweeper — reclaims stock from expired holds.
//
// Runs in the worker process (not the api) because in prod we scale reclaim
// throughput independently of request throughput. For now it's a single-node
// interval loop; when we outgrow that, swap it for a BullMQ repeatable job.
//
// The race with `POST /reservations/:id/confirm`:
//   Both sides do `findOneAndUpdate({status:"held", ...})`. Mongo serialises the
//   two updates; whichever lands first wins, the other's predicate fails and its
//   $set is a no-op. That guarantees:
//     * confirmed reservations are NEVER refunded to the stock pool
//     * expired reservations are refunded EXACTLY ONCE
//
// Model / stockKey are duplicated (not imported from api/) on purpose: worker
// and api are separate deploy units and we don't want a shared runtime dep.

import mongoose, { Schema } from "mongoose";
import type { Redis as IORedis } from "ioredis";
import type { Logger } from "pino";
import { STOCK_CHANNEL, type StockEvent } from "@flashkart/shared";

const reservationSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    quantity: { type: Number, required: true, min: 1 },
    status: { type: String, required: true, default: "held" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
reservationSchema.index({ status: 1, expiresAt: 1 });

const ReservationModel = mongoose.model("Reservation", reservationSchema);

const stockKey = (productId: string) => `stock:${productId}`;

const SWEEP_INTERVAL_MS = 5_000;
const MAX_PER_TICK = 100;

export function startReservationSweeper(redis: IORedis, logger: Logger): () => void {
  let stopped = false;
  let inflight = false;

  const tick = async () => {
    if (stopped || inflight) return;
    inflight = true;
    try {
      let reclaimed = 0;
      const now = new Date();
      for (let i = 0; i < MAX_PER_TICK; i++) {
        const doc = await ReservationModel.findOneAndUpdate(
          { status: "held", expiresAt: { $lte: now } },
          { $set: { status: "expired" } },
          { new: true },
        ).lean();
        if (!doc) break;
        const productId = doc.productId.toString();
        const newRemaining = await redis.incrby(stockKey(productId), doc.quantity);
        const event: StockEvent = {
          productId,
          remaining: newRemaining,
          reason: "sweep_expired",
          ts: Date.now(),
        };
        await redis.publish(STOCK_CHANNEL, JSON.stringify(event));
        reclaimed++;
      }
      if (reclaimed > 0) logger.info({ reclaimed }, "sweeper: reclaimed expired holds");
    } catch (err) {
      logger.error({ err }, "sweeper: tick failed");
    } finally {
      inflight = false;
    }
  };

  const handle = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  // Kick off immediately so first sweep doesn't wait a full interval.
  void tick();

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
