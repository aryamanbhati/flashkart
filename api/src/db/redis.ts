// ioredis singleton. Two connections up front:
//
//   `redis`     — general-purpose: cache, atomic ops, rate limit, key-value.
//   `redisSub`  — dedicated pub/sub subscriber (Phase 4).
//
// Why two? A Redis client that has run `SUBSCRIBE` enters subscriber mode and
// can no longer issue normal commands until it UNSUBSCRIBEs. So pub/sub always
// needs its own connection. We construct the subscriber lazily in Phase 4;
// this file exports only the general one for now.
//
// ioredis reconnects automatically. We set `maxRetriesPerRequest: null` so
// long-running BullMQ consumers don't get their blocking commands rejected
// mid-reconnect (BullMQ requires this exact setting).

import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on("connect", () => logger.info("redis connecting"));
redis.on("ready", () => logger.info("redis ready"));
redis.on("error", (err) => logger.error({ err }, "redis error"));
redis.on("close", () => logger.warn("redis connection closed"));

export async function pingRedis(): Promise<boolean> {
  try {
    const res = await redis.ping();
    return res === "PONG";
  } catch {
    return false;
  }
}
