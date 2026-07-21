// Fire-and-forget stock event publisher. Errors are logged and swallowed —
// realtime updates are best-effort UX; a Redis blip should not fail a checkout.
//
// The subscriber side lives in socket.ts. Kept separate so worker code can
// import ONLY the publisher without pulling in Socket.io.

import { redis } from "../db/redis.js";
import { logger } from "../utils/logger.js";
import { STOCK_CHANNEL, type StockEvent, type StockEventReason } from "@flashkart/shared";

export async function publishStockUpdate(
  productId: string,
  remaining: number,
  reason: StockEventReason,
): Promise<void> {
  const event: StockEvent = { productId, remaining, reason, ts: Date.now() };
  try {
    await redis.publish(STOCK_CHANNEL, JSON.stringify(event));
  } catch (err) {
    logger.warn({ err, productId }, "publishStockUpdate failed");
  }
}
