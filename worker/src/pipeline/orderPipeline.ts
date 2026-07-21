// Three-stage order pipeline as BullMQ Workers.
//
//   process → payment.charge → status: paid    → enqueue fulfill
//   fulfill → warehouse stub → status: fulfilled → enqueue notify
//   notify  → email stub    → status: confirmed
//
// Correctness:
//   * At-least-once delivery. Every handler gates on the CURRENT order status
//     with a compare-and-set update; if the order has already moved past this
//     stage, the handler no-ops. That makes duplicate deliveries safe.
//   * On payment terminal failure (all retries exhausted): compensate by
//     INCRBY-ing the stock back, mark the order failed, publish a stock event
//     so the UI stops seeing phantom decrement.

import { Worker, type Job } from "bullmq";
import type { Redis as IORedis } from "ioredis";
import type { Logger } from "pino";
import {
  QUEUE_ORDERS_PROCESS,
  QUEUE_ORDERS_FULFILL,
  QUEUE_ORDERS_NOTIFY,
  ORDER_CHANNEL,
  STOCK_CHANNEL,
  type ProcessOrderJob,
  type FulfillOrderJob,
  type NotifyOrderJob,
  type OrderEvent,
  type StockEvent,
} from "@flashkart/shared";
import { OrderModel, stockKey } from "../models.js";
import { chargePayment } from "./payment.js";

// Queue-level retry+backoff. Same shape used by producer defaults — kept here
// too because a Worker with its own settings is the safer place if a producer
// forgets to set them.
const JOB_ATTEMPTS = 3;

type BuildDeps = {
  connection: IORedis;
  logger: Logger;
  publish: (event: OrderEvent) => Promise<void>;
  publishStock: (event: StockEvent) => Promise<void>;
  enqueueFulfill: (orderId: string) => Promise<unknown>;
  enqueueNotify: (orderId: string) => Promise<unknown>;
};

// ---- payment / process --------------------------------------------------

function buildProcessWorker(deps: BuildDeps): Worker<ProcessOrderJob> {
  return new Worker<ProcessOrderJob>(
    QUEUE_ORDERS_PROCESS,
    async (job: Job<ProcessOrderJob>) => {
      const { orderId } = job.data;
      const order = await OrderModel.findById(orderId);
      if (!order) throw new Error(`order ${orderId} not found`);

      // Idempotency gate: if we've already moved past `pending`, this delivery
      // is a duplicate. Return without side effects.
      if (order.status !== "pending") {
        deps.logger.info({ orderId, status: order.status }, "process: already past pending");
        return;
      }

      order.paymentAttempts = (order.paymentAttempts ?? 0) + 1;
      await order.save();

      await chargePayment(orderId, order.totalPaise);

      // Compare-and-set: only flip pending→paid. If a concurrent worker
      // already did it (BullMQ concurrency > 1 shouldn't cause this because
      // BullMQ locks the job, but belt-and-braces), the update matches nothing.
      const updated = await OrderModel.findOneAndUpdate(
        { _id: orderId, status: "pending" },
        { $set: { status: "paid" } },
        { new: true },
      ).lean();
      if (!updated) return; // someone else won

      await deps.publish({
        orderId,
        userId: updated.userId.toString(),
        status: "paid",
        ts: Date.now(),
      });
      await deps.enqueueFulfill(orderId);
    },
    { connection: deps.connection, concurrency: 5 },
  );
}

async function compensatePayment(deps: BuildDeps, orderId: string, reason: string) {
  // findOneAndUpdate with the {status:"pending"} predicate keeps compensation
  // idempotent — if the order somehow moved off pending (e.g. a late success),
  // we won't double-refund stock.
  const order = await OrderModel.findOneAndUpdate(
    { _id: orderId, status: "pending" },
    { $set: { status: "failed", failureReason: reason } },
    { new: true },
  ).lean();
  if (!order) {
    deps.logger.warn({ orderId }, "compensate: order not in pending — skipping");
    return;
  }

  const newRemaining = await deps.connection.incrby(
    stockKey(order.productId.toString()),
    order.quantity,
  );
  deps.logger.warn(
    { orderId, returned: order.quantity, reason },
    "payment failed after retries — stock compensated",
  );

  await deps.publishStock({
    productId: order.productId.toString(),
    remaining: newRemaining,
    reason: "release",
    ts: Date.now(),
  });
  await deps.publish({
    orderId,
    userId: order.userId.toString(),
    status: "failed",
    ts: Date.now(),
  });
}

// ---- fulfill ------------------------------------------------------------

function buildFulfillWorker(deps: BuildDeps): Worker<FulfillOrderJob> {
  return new Worker<FulfillOrderJob>(
    QUEUE_ORDERS_FULFILL,
    async (job: Job<FulfillOrderJob>) => {
      const { orderId } = job.data;
      const order = await OrderModel.findById(orderId).lean();
      if (!order) throw new Error(`order ${orderId} not found`);
      if (order.status !== "paid") {
        deps.logger.info({ orderId, status: order.status }, "fulfill: not in paid");
        return;
      }

      // Simulated warehouse work.
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));

      const updated = await OrderModel.findOneAndUpdate(
        { _id: orderId, status: "paid" },
        { $set: { status: "fulfilled" } },
        { new: true },
      ).lean();
      if (!updated) return;

      await deps.publish({
        orderId,
        userId: updated.userId.toString(),
        status: "fulfilled",
        ts: Date.now(),
      });
      await deps.enqueueNotify(orderId);
    },
    { connection: deps.connection, concurrency: 5 },
  );
}

// ---- notify -------------------------------------------------------------

function buildNotifyWorker(deps: BuildDeps): Worker<NotifyOrderJob> {
  return new Worker<NotifyOrderJob>(
    QUEUE_ORDERS_NOTIFY,
    async (job: Job<NotifyOrderJob>) => {
      const { orderId } = job.data;
      const order = await OrderModel.findById(orderId).lean();
      if (!order) throw new Error(`order ${orderId} not found`);
      if (order.status !== "fulfilled") return;

      // Simulated email send.
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
      deps.logger.info({ orderId, userId: order.userId.toString() }, "notify: email sent (stub)");

      const updated = await OrderModel.findOneAndUpdate(
        { _id: orderId, status: "fulfilled" },
        { $set: { status: "confirmed" } },
        { new: true },
      ).lean();
      if (!updated) return;

      await deps.publish({
        orderId,
        userId: updated.userId.toString(),
        status: "confirmed",
        ts: Date.now(),
      });
    },
    { connection: deps.connection, concurrency: 10 },
  );
}

// ---- entrypoint ---------------------------------------------------------

export function startOrderPipeline(
  connection: IORedis,
  logger: Logger,
  enqueueFulfill: (orderId: string) => Promise<unknown>,
  enqueueNotify: (orderId: string) => Promise<unknown>,
) {
  const publish = async (event: OrderEvent) => {
    await connection.publish(ORDER_CHANNEL, JSON.stringify(event));
  };
  const publishStock = async (event: StockEvent) => {
    await connection.publish(STOCK_CHANNEL, JSON.stringify(event));
  };

  const deps: BuildDeps = {
    connection,
    logger,
    publish,
    publishStock,
    enqueueFulfill,
    enqueueNotify,
  };

  const processWorker = buildProcessWorker(deps);
  const fulfillWorker = buildFulfillWorker(deps);
  const notifyWorker = buildNotifyWorker(deps);

  // Compensation trigger: BullMQ fires `failed` after ALL retries have been
  // exhausted. That's exactly the terminal-failure signal we need.
  processWorker.on("failed", (job, err) => {
    if (!job) return;
    if (job.attemptsMade < JOB_ATTEMPTS) return; // not terminal yet
    void compensatePayment(deps, job.data.orderId, err.message).catch((e) => {
      logger.error({ err: e, orderId: job.data.orderId }, "compensation failed");
    });
  });

  processWorker.on("error", (err) => logger.error({ err }, "process worker error"));
  fulfillWorker.on("error", (err) => logger.error({ err }, "fulfill worker error"));
  notifyWorker.on("error", (err) => logger.error({ err }, "notify worker error"));

  logger.info("order pipeline workers running (process/fulfill/notify)");

  return async () => {
    await Promise.all([processWorker.close(), fulfillWorker.close(), notifyWorker.close()]);
  };
}
