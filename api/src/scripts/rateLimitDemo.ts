// Rate-limit proof. Fires N buys sequentially from a single IP and reports
// which succeeded vs got 429. Expect the first ~capacity requests to pass
// (bucket full), then ~1 to slip through per (1/refillPerSec) seconds.
//
// Run: docker compose exec api npx tsx src/scripts/rateLimitDemo.ts <productId> [attempts]

const API_URL = process.env.INTERNAL_API_URL ?? "http://localhost:4000";

async function main() {
  const productId = process.argv[2];
  const attempts = Number(process.argv[3] ?? 12);
  if (!productId) {
    console.error("usage: rateLimitDemo.ts <productId> [attempts]");
    process.exit(1);
  }

  console.log(`firing ${attempts} back-to-back buys (no bypass) — bucket = 5 tokens, refill 0.5/s`);
  console.log(`expected: first ~5 pass, then most are 429 until tokens refill\n`);

  const results: { i: number; status: number; remaining: string | null; retryAfter: string | null }[] = [];

  for (let i = 1; i <= attempts; i++) {
    const t0 = Date.now();
    const res = await fetch(`${API_URL}/products/${productId}/buy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: 1 }),
    });
    results.push({
      i,
      status: res.status,
      remaining: res.headers.get("X-RateLimit-Remaining"),
      retryAfter: res.headers.get("Retry-After"),
    });
    const dt = Date.now() - t0;
    console.log(
      `  #${String(i).padStart(2)}  status=${res.status}  remaining=${
        res.headers.get("X-RateLimit-Remaining") ?? "-"
      }  retryAfter=${res.headers.get("Retry-After") ?? "-"}s  (${dt}ms)`,
    );
  }

  const ok = results.filter((r) => r.status === 201).length;
  const limited = results.filter((r) => r.status === 429).length;
  const soldOut = results.filter((r) => r.status === 409).length;
  const other = attempts - ok - limited - soldOut;

  console.log(`\nsummary:`);
  console.log(`  201 confirmed  : ${ok}`);
  console.log(`  429 limited    : ${limited}`);
  console.log(`  409 sold out   : ${soldOut}`);
  console.log(`  other          : ${other}`);

  if (limited > 0 && ok > 0 && ok <= 6) {
    console.log(`\n  >> PASS: limiter kicked in after the burst.`);
  } else {
    console.log(`\n  >> CHECK: expected some 201s then 429s.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
