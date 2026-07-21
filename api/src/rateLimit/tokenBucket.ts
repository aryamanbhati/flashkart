// Token-bucket rate limiter — one atomic Lua script per check.
//
// Why token bucket:
//   * Handles bursts cleanly (up to `capacity` at once) but caps steady-state.
//   * State per key = {tokens, lastRefillMs} — 2 numbers, O(1) memory.
//   * Whole read-modify-write happens inside Redis, so N api pods can share
//     the same bucket without a distributed lock. Same pattern as our inventory
//     decrement.
//
// State layout: hash {t: tokens, l: lastMs}. TTL = 2× the time to fully refill;
// idle keys expire so a big burst of unique IPs doesn't grow Redis unboundedly.

import { redis } from "../db/redis.js";

const RATE_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 't', 'l')
local tokens = tonumber(data[1])
local last = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  last = now
end

local elapsedMs = now - last
if elapsedMs < 0 then elapsedMs = 0 end
tokens = math.min(capacity, tokens + (elapsedMs / 1000.0) * refill)

local allowed = 0
local retryAfterMs = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  local deficit = cost - tokens
  retryAfterMs = math.ceil((deficit / refill) * 1000)
end

redis.call('HMSET', key, 't', tokens, 'l', now)
local ttl = math.ceil((capacity / refill) * 2)
redis.call('EXPIRE', key, ttl)

return { allowed, math.floor(tokens), retryAfterMs }
`;

redis.defineCommand("rateCheck", { numberOfKeys: 1, lua: RATE_LUA });

interface RateCommands {
  rateCheck(
    key: string,
    capacity: number,
    refillPerSec: number,
    nowMs: number,
    cost: number,
  ): Promise<[number, number, number]>;
}
const rl = redis as unknown as typeof redis & RateCommands;

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

export async function checkRate(
  key: string,
  capacity: number,
  refillPerSec: number,
  cost = 1,
): Promise<RateLimitDecision> {
  const [allowed, remaining, retryAfterMs] = await rl.rateCheck(
    key,
    capacity,
    refillPerSec,
    Date.now(),
    cost,
  );
  return { allowed: allowed === 1, remaining, retryAfterMs };
}
