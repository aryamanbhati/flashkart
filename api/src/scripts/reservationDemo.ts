// Reservation flow demo. Uses a SHORT test TTL by monkey-patching expiresAt via
// a follow-up direct Mongo write, because the real 90s TTL is too long for a demo.
//
// Run: docker compose exec api npx tsx src/scripts/reservationDemo.ts <productId>

import mongoose from "mongoose";
import { ReservationModel } from "../models/Reservation.js";

const API_URL = process.env.INTERNAL_API_URL ?? "http://localhost:4000";
const MONGO_URI = process.env.MONGO_URI ?? "mongodb://mongo:27017/flashkart";

async function stock(productId: string): Promise<number | null> {
  const r = await fetch(`${API_URL}/products/${productId}`).then((x) => x.json());
  return r?.product?.liveStock ?? null;
}

async function main() {
  const productId = process.argv[2];
  if (!productId) {
    console.error("usage: reservationDemo.ts <productId>");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI, { bufferCommands: false });

  console.log("=".repeat(60));
  console.log("SCENARIO 1: reserve -> confirm (happy path)");
  console.log("=".repeat(60));

  const s0 = await stock(productId);
  console.log(`  stock before        : ${s0}`);

  const r1 = await fetch(`${API_URL}/products/${productId}/reserve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantity: 1 }),
  }).then((x) => x.json() as Promise<{ reservationId: string; expiresAt: string }>);
  console.log(`  reserved            : ${r1.reservationId} (expires ${r1.expiresAt})`);

  const s1 = await stock(productId);
  console.log(`  stock after reserve : ${s1}  (should be ${s0! - 1})`);

  const c1 = await fetch(`${API_URL}/reservations/${r1.reservationId}/confirm`, {
    method: "POST",
  });
  console.log(`  confirm status      : ${c1.status}  (should be 200)`);
  const s2 = await stock(productId);
  console.log(`  stock after confirm : ${s2}  (should stay ${s0! - 1} — no refund)`);

  console.log("");
  console.log("=".repeat(60));
  console.log("SCENARIO 2: reserve -> let it expire -> sweeper returns stock");
  console.log("=".repeat(60));

  const r2 = await fetch(`${API_URL}/products/${productId}/reserve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantity: 1 }),
  }).then((x) => x.json() as Promise<{ reservationId: string; expiresAt: string }>);
  console.log(`  reserved            : ${r2.reservationId}`);
  const s3 = await stock(productId);
  console.log(`  stock after reserve : ${s3}  (down by 1)`);

  // Force-expire this reservation by rewinding its expiresAt.
  await ReservationModel.updateOne(
    { _id: r2.reservationId },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );
  console.log(`  (forced expiresAt into the past — waiting up to 8s for sweeper)`);

  const deadline = Date.now() + 8000;
  let sweptStock: number | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const now = await stock(productId);
    if (now === s3! + 1) {
      sweptStock = now;
      break;
    }
  }
  console.log(`  stock after sweep   : ${sweptStock}  (should be ${s3! + 1} — sweeper returned it)`);

  const c2 = await fetch(`${API_URL}/reservations/${r2.reservationId}/confirm`, {
    method: "POST",
  });
  console.log(`  confirm status      : ${c2.status}  (should be 410 — expired)`);

  console.log("");
  console.log("=".repeat(60));
  console.log("SCENARIO 3: race — sweeper vs confirm on a just-expired hold");
  console.log("=".repeat(60));

  const r3 = await fetch(`${API_URL}/products/${productId}/reserve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quantity: 1 }),
  }).then((x) => x.json() as Promise<{ reservationId: string; expiresAt: string }>);
  console.log(`  reserved            : ${r3.reservationId}`);
  const s5 = await stock(productId);

  // Rewind AND fire the confirm as fast as possible.
  await ReservationModel.updateOne(
    { _id: r3.reservationId },
    { $set: { expiresAt: new Date(Date.now() - 1) } },
  );
  const [confirmRes] = await Promise.all([
    fetch(`${API_URL}/reservations/${r3.reservationId}/confirm`, { method: "POST" }),
  ]);
  console.log(`  confirm status      : ${confirmRes.status}  (either 200 or 410 — never both)`);

  // Give the sweeper time to run either way, then check invariant.
  await new Promise((r) => setTimeout(r, 6000));
  const s6 = await stock(productId);
  const doc = await ReservationModel.findById(r3.reservationId).lean();

  const okConfirm = confirmRes.status === 200 && doc?.status === "confirmed" && s6 === s5;
  const okExpire = confirmRes.status === 410 && doc?.status === "expired" && s6 === s5! + 1;
  console.log(`  final status doc    : ${doc?.status}`);
  console.log(`  stock delta         : ${s6! - s5!}  (0 if confirmed, +1 if expired)`);
  if (okConfirm) console.log(`  >> PASS: confirm won cleanly, no double-refund.`);
  else if (okExpire) console.log(`  >> PASS: sweeper won cleanly, stock returned exactly once.`);
  else console.log(`  >> FAIL: invariant broken!`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
