// Fires a swarm of concurrent HTTP buys at the REAL /buy endpoint.
// This proves the whole request path — Express, the route, the inventory
// service, the Lua script — holds under concurrency, not just Redis in isolation.
//
// Run: docker compose exec api npx tsx src/scripts/buyStorm.ts <productId> [buyers]

const API_URL = process.env.INTERNAL_API_URL ?? "http://localhost:4000";

async function main() {
  const productId = process.argv[2];
  const buyers = Number(process.argv[3] ?? 300);
  if (!productId) {
    console.error("usage: buyStorm.ts <productId> [buyers]");
    process.exit(1);
  }

  // Read starting live stock.
  const before = await fetch(`${API_URL}/products/${productId}`).then((r) => r.json());
  const startStock: number | null = before?.product?.liveStock ?? before?.product?.stock ?? null;

  console.log(`firing ${buyers} concurrent buys at product ${productId}`);
  console.log(`stock before: ${startStock}`);

  const attempts = Array.from({ length: buyers }, () =>
    fetch(`${API_URL}/products/${productId}/buy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Bypass": process.env.RATE_LIMIT_BYPASS_TOKEN ?? "",
        Authorization: `Bearer ${process.env.LOAD_TEST_TOKEN ?? ""}`,
      },
      body: JSON.stringify({ quantity: 1 }),
    }).then((r) => r.status),
  );

  const statuses = await Promise.all(attempts);
  const confirmed = statuses.filter((s) => s === 201).length;
  const soldOut = statuses.filter((s) => s === 409).length;
  const other = statuses.length - confirmed - soldOut;

  const after = await fetch(`${API_URL}/products/${productId}`).then((r) => r.json());
  const endStock: number | null = after?.product?.liveStock ?? null;

  console.log(`\nresults:`);
  console.log(`  confirmed (201) : ${confirmed}`);
  console.log(`  sold out  (409) : ${soldOut}`);
  console.log(`  other           : ${other}`);
  console.log(`  stock after     : ${endStock}`);

  const expected = typeof startStock === "number" ? startStock : 0;
  if (confirmed === expected && endStock === 0) {
    console.log(`\n  >> PASS: sold exactly ${confirmed} = starting stock, zero oversell.`);
  } else {
    console.log(`\n  >> CHECK: confirmed=${confirmed}, expected=${expected}, endStock=${endStock}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
