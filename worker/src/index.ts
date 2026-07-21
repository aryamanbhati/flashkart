// Worker process. Phase 1 stub — just proves the container boots and can talk
// to Mongo + Redis. Phase 5 will wire up BullMQ Workers for the async order
// pipeline (order-placed → payment → fulfillment → email).
//
// Kept as a SEPARATE process (not a thread in the api) because in prod we
// want to scale worker replicas independently of api pods — a big sale spike
// hits the api hard but the queue-drain rate is bounded by the payment provider.

import "dotenv/config";
import { z } from "zod";
import mongoose from "mongoose";
import { Redis as IORedis } from "ioredis";
import { pino } from "pino";
import { Queue } from "bullmq";
import {
  QUEUE_ORDERS_FULFILL,
  QUEUE_ORDERS_NOTIFY,
} from "@flashkart/shared";
import { startReservationSweeper } from "./sweeper.js";
import { startOrderPipeline } from "./pipeline/orderPipeline.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MONGO_URI: z.string().min(1),
  REDIS_URL: z.string().min(1),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("worker: invalid env", parsed.error.issues);
  process.exit(1);
}
const env = parsed.data;

const logger = pino({ level: env.NODE_ENV === "production" ? "info" : "debug" });

async function main() {
  await mongoose.connect(env.MONGO_URI, { bufferCommands: false });
  logger.info("worker: mongo connected");

  const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  await redis.ping();
  logger.info("worker: redis connected");

  const stopSweeper = startReservationSweeper(redis, logger);
  logger.info("worker: reservation sweeper running (5s tick)");

  // Producer-side Queue handles used by the pipeline handlers to enqueue the
  // next stage. Same Redis connection is fine — workers use their own.
  const fulfillQ = new Queue(QUEUE_ORDERS_FULFILL, { connection: redis });
  const notifyQ = new Queue(QUEUE_ORDERS_NOTIFY, { connection: redis });
  const jobOpts = {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 500 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 24 * 3600 },
  };
  const stopPipeline = startOrderPipeline(
    redis,
    logger,
    (orderId) => fulfillQ.add("fulfill", { orderId }, jobOpts),
    (orderId) => notifyQ.add("notify", { orderId }, jobOpts),
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker: shutting down");
    stopSweeper();
    await stopPipeline();
    await fulfillQ.close();
    await notifyQ.close();
    await mongoose.disconnect();
    redis.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "worker: boot failed");
  process.exit(1);
});
