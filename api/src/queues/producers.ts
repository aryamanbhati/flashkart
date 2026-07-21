// Queue producers. The api process only enqueues; workers consume.
//
// BullMQ needs its OWN Redis connection with `maxRetriesPerRequest: null`
// (blocking commands like BRPOPLPUSH would otherwise be rejected mid-reconnect).
// We reuse the app's main redis client because it's already configured that way.

import { Queue, type JobsOptions } from "bullmq";
import { redis } from "../db/redis.js";
import {
  QUEUE_ORDERS_PROCESS,
  QUEUE_ORDERS_FULFILL,
  QUEUE_ORDERS_NOTIFY,
  type ProcessOrderJob,
  type FulfillOrderJob,
  type NotifyOrderJob,
} from "@flashkart/shared";

const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 500 },
  removeOnComplete: { age: 3600, count: 1000 }, // keep 1h / last 1k for debugging
  removeOnFail: { age: 24 * 3600 }, // keep failures a day for postmortem
};

export const ordersProcessQueue = new Queue<ProcessOrderJob>(QUEUE_ORDERS_PROCESS, {
  connection: redis,
});
export const ordersFulfillQueue = new Queue<FulfillOrderJob>(QUEUE_ORDERS_FULFILL, {
  connection: redis,
});
export const ordersNotifyQueue = new Queue<NotifyOrderJob>(QUEUE_ORDERS_NOTIFY, {
  connection: redis,
});

export function enqueueProcessOrder(orderId: string) {
  return ordersProcessQueue.add("process", { orderId }, DEFAULT_JOB_OPTS);
}
