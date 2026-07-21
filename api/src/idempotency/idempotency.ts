// Idempotency helper — retry-safe wrapper for side-effectful endpoints.
//
// Pattern:
//   1. Client sends `Idempotency-Key: <uuid>` — same key for every retry of one intent.
//   2. First request wins a Redis lock (SET NX), executes fn(), stores result.
//   3. Concurrent duplicates lose the lock and short-poll for the stored result.
//   4. Later replays skip fn() entirely and return the stored result.
//
// Why the lock? Without it, two near-simultaneous requests both see "no cache",
// both execute, and the underlying side-effect (stock decrement) happens twice
// — exactly the bug we're preventing.

import { redis } from "../db/redis.js";

const RESULT_TTL_SECONDS = 24 * 60 * 60; // 24h — long enough to swallow any retry
const LOCK_TTL_SECONDS = 30;              // stale locks self-heal
const POLL_INTERVAL_MS = 25;
const POLL_TIMEOUT_MS = 5000;

const PENDING_MARKER = "__pending__";

export type IdemResult<T> = {
  replayed: boolean;
  value: T;
};

export type StoredResult<T> = {
  status: number;
  body: T;
};

// Run `fn` at most once for a given key. Concurrent callers with the same key
// wait for the first one's result; later callers just replay it.
export async function withIdempotency<T>(
  key: string,
  fn: () => Promise<StoredResult<T>>,
): Promise<IdemResult<StoredResult<T>>> {
  const redisKey = `idem:${key}`;

  // 1. Try to claim the key. NX = only set if absent → race-free winner.
  const claimed = await redis.set(redisKey, PENDING_MARKER, "EX", LOCK_TTL_SECONDS, "NX");

  if (claimed === "OK") {
    // We won. Execute for real, cache the response, return it.
    try {
      const result = await fn();
      await redis.set(redisKey, JSON.stringify(result), "EX", RESULT_TTL_SECONDS);
      return { replayed: false, value: result };
    } catch (err) {
      // fn threw — release the lock so a retry can try again cleanly.
      await redis.del(redisKey);
      throw err;
    }
  }

  // 2. Lost the race. Poll for the winner's result.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const existing = await redis.get(redisKey);
    if (existing && existing !== PENDING_MARKER) {
      return { replayed: true, value: JSON.parse(existing) as StoredResult<T> };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Winner hung. Very rare — treat as an error the client can retry.
  throw new Error("idempotency wait timeout");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
