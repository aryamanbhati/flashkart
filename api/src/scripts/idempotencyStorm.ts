// Fires N concurrent buys at the SAME product with the SAME Idempotency-Key.
// Without idempotency: N units gone. With it: exactly 1.
//
// Run: docker compose exec api npx tsx src/scripts/idempotencyStorm.ts <productId> [buyers]

import { randomUUID } from "node:crypto";

const API_URL = process.env.INTERNAL_API_URL ?? "http://localhost:4000";

async function main() {
  const productId = process.argv[2];
  const buyers = Number(process.argv[3] ?? 20);
  if (!productId) {
    console.error("usage: idempotencyStorm.ts <productId> [buyers]");
    process.exit(1);
  }

  const before = await fetch(`${API_URL}/products/${productId}`).then((r) => r.json());
  const startStock: number | null = before?.product?.liveStock ?? before?.product?.stock ?? null;

  const key = randomUUID();
  console.log(`firing ${buyers} concurrent buys with SAME key ${key}`);
  console.log(`stock before: ${startStock}`);

  const attempts = Array.from({ length: buyers }, () =>
    fetch(`${API_URL}/products/${productId}/buy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        "X-RateLimit-Bypass": process.env.RATE_LIMIT_BYPASS_TOKEN ?? "",
        Authorization: `Bearer ${process.env.LOAD_TEST_TOKEN ?? ""}`,
      },
      body: JSON.stringify({ quantity: 1 }),
    }).then(async (r) => ({
      status: r.status,
      replayed: r.headers.get("Idempotent-Replay"),
      body: await r.json().catch(() => null),
    })),
  );

  const results = await Promise.all(attempts);
  const confirmed = results.filter((r) => r.status === 201).length;
  const replayed = results.filter((r) => r.replayed === "true").length;
  const original = results.filter((r) => r.replayed === "false").length;

  const after = await fetch(`${API_URL}/products/${productId}`).then((r) => r.json());
  const endStock: number | null = after?.product?.liveStock ?? null;

  const deducted = typeof startStock === "number" && typeof endStock === "number"
    ? startStock - endStock
    : null;

  console.log(`\nresults:`);
  console.log(`  201 responses  : ${confirmed} / ${buyers}`);
  console.log(`  original run   : ${original}  (should be 1)`);
  console.log(`  replays        : ${replayed}  (should be ${buyers - 1})`);
  console.log(`  stock deducted : ${deducted}  (should be 1)`);

  if (confirmed === buyers && original === 1 && replayed === buyers - 1 && deducted === 1) {
    console.log(`\n  >> PASS: ${buyers} requests, one real purchase, all others replayed.`);
  } else {
    console.log(`\n  >> CHECK: something didn't match expectations.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
