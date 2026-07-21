// ---------------------------------------------------------------------------
// OVERSELL DEMO
//
// Fires a swarm of concurrent "buyers" at a single item, twice:
//   1. NAIVE   — read-then-write in JavaScript (the broken way).
//   2. ATOMIC  — a single Lua script inside Redis (the crown-jewel way).
//
// We start each run with STOCK units and unleash BUYERS concurrent buy attempts.
// A correct system lets EXACTLY `STOCK` buyers succeed and tells the rest "sold out".
// Overselling = more successes than we had stock. That's the bug we're proving/fixing.
//
// Run it (from the repo root, stack already up):
//   docker compose exec api npx tsx src/scripts/oversellDemo.ts
// ---------------------------------------------------------------------------

import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://redis:6379";
const STOCK = 10; // how many units actually exist
const BUYERS = 500; // how many people mash "buy" at the same instant

const KEY_NAIVE = "demo:stock:naive";
const KEY_ATOMIC = "demo:stock:atomic";

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

// ---------------------------------------------------------------------------
// THE ATOMIC LUA SCRIPT — the whole crown jewel, in five lines.
//
// Redis runs this ENTIRE script as one unbreakable instruction. Nothing else
// can touch the key while it runs — so the check and the subtract can never be
// split apart. That single guarantee is what makes overselling impossible.
//
//   KEYS[1]  = the stock key
//   returns  1  -> bought (stock was > 0, we subtracted one)
//            0  -> sold out (stock was 0)
//           -1  -> key not initialised
// ---------------------------------------------------------------------------
const BUY_LUA = `
local stock = tonumber(redis.call('GET', KEYS[1]))
if stock == nil then return -1 end
if stock <= 0 then return 0 end
redis.call('DECR', KEYS[1])
return 1
`;

// Register the script as a custom command on this connection. ioredis SHA-loads
// it into Redis and lets us call redis.buyStock(key) like any built-in command.
redis.defineCommand("buyStock", { numberOfKeys: 1, lua: BUY_LUA });

// TypeScript doesn't know about our custom command, so we describe its shape.
interface RedisWithBuy extends Redis {
  buyStock(key: string): Promise<number>;
}
const r = redis as RedisWithBuy;

// ---------------------------------------------------------------------------
// THE NAIVE BUYER — read, think, write. Three separate steps in JS.
// The `await` between GET and SET is the "gap" where another buyer sneaks in
// and reads the same stale number. This is what a beginner would write, and
// it is exactly wrong under concurrency.
// ---------------------------------------------------------------------------
async function naiveBuy(key: string): Promise<boolean> {
  const current = Number(await redis.get(key));
  if (current > 0) {
    // yield to the event loop — widens the gap so the race is visible every run
    await new Promise((res) => setImmediate(res));
    await redis.set(key, String(current - 1));
    return true; // "I bought it!"
  }
  return false; // sold out
}

// ---------------------------------------------------------------------------
// THE ATOMIC BUYER — one call. Check + subtract happen together inside Redis.
// ---------------------------------------------------------------------------
async function atomicBuy(key: string): Promise<boolean> {
  const result = await r.buyStock(key);
  return result === 1;
}

async function runSwarm(
  label: string,
  key: string,
  buy: (key: string) => Promise<boolean>,
): Promise<void> {
  await redis.set(key, String(STOCK));

  // Fire all BUYERS attempts "at once" and wait for every one to settle.
  const attempts = Array.from({ length: BUYERS }, () => buy(key));
  const results = await Promise.all(attempts);

  const sold = results.filter(Boolean).length;
  const finalStock = Number(await redis.get(key));
  const oversold = Math.max(0, sold - STOCK);

  console.log(`\n${label}`);
  console.log(`  units available at start : ${STOCK}`);
  console.log(`  concurrent buyers        : ${BUYERS}`);
  console.log(`  buyers who "succeeded"   : ${sold}`);
  console.log(`  stock left in Redis      : ${finalStock}`);
  if (oversold > 0) {
    console.log(`  >> OVERSOLD by ${oversold} units — we promised more than we had!`);
  } else {
    console.log(`  >> correct: sold exactly ${sold}, no overselling.`);
  }
}

async function main() {
  console.log("=".repeat(56));
  console.log(`Oversell demo — ${STOCK} units, ${BUYERS} concurrent buyers`);
  console.log("=".repeat(56));

  await runSwarm("NAIVE  (read-then-write in JavaScript)", KEY_NAIVE, naiveBuy);
  await runSwarm("ATOMIC (single Lua script in Redis)", KEY_ATOMIC, atomicBuy);

  await redis.del(KEY_NAIVE, KEY_ATOMIC);
  await redis.quit();
  console.log("\ndone.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
