// Refresh-token rotation + reuse detection proof.
//
// Steps:
//   1. Register + login → get access A0 and refresh cookie RT0.
//   2. Call /auth/refresh with RT0 → get A1 and RT1 (RT0 is now stale).
//   3. Try to reuse RT0 (the "attacker" scenario) → 401 AND the family is nuked.
//   4. Confirm even the legit RT1 is now dead.
//
// Run: docker compose exec api npx tsx src/scripts/refreshReuseDemo.ts

const API_URL = process.env.INTERNAL_API_URL ?? "http://localhost:4000";
const EMAIL = `rotation+${Date.now()}@flashkart.local`;
const PW = "correct-horse-battery-staple";

function cookieHeaderFromSetCookie(setCookie: string[] | null): string {
  if (!setCookie) return "";
  return setCookie
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function main() {
  console.log("=".repeat(60));
  console.log("REFRESH TOKEN ROTATION + REUSE DETECTION");
  console.log("=".repeat(60));

  // 1. Register
  await fetch(`${API_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, name: "Rotation Bot", password: PW }),
  });

  // 2. Login → RT0
  const loginRes = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  });
  const loginSetCookie = (loginRes.headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie?.() ?? loginRes.headers.get("set-cookie")?.split(",") ?? null;
  const rt0 = cookieHeaderFromSetCookie(loginSetCookie);
  console.log(`  login          : ${loginRes.status}  RT0=${rt0.slice(0, 20)}...`);

  // 3. Rotate: use RT0 → get RT1
  const rot1 = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    headers: { Cookie: rt0 },
  });
  const rot1SetCookie = (rot1.headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie?.() ?? rot1.headers.get("set-cookie")?.split(",") ?? null;
  const rt1 = cookieHeaderFromSetCookie(rot1SetCookie);
  console.log(`  refresh (RT0)  : ${rot1.status}  RT1=${rt1.slice(0, 20)}...  (should be 200)`);

  // 4. REUSE RT0 (attacker scenario)
  const reuse = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    headers: { Cookie: rt0 },
  });
  const reuseBody = await reuse.text();
  console.log(`  reuse (RT0)    : ${reuse.status}  ${reuseBody}  (should be 401)`);

  // 5. Legit user tries RT1 — should also fail now (family nuked)
  const post = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    headers: { Cookie: rt1 },
  });
  const postBody = await post.text();
  console.log(`  legit (RT1)    : ${post.status}  ${postBody}  (should be 401 — family revoked)`);

  const pass =
    rot1.status === 200 && reuse.status === 401 && post.status === 401;
  console.log(pass ? "\n  >> PASS" : "\n  >> FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
