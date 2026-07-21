// Compensation proof: force payment to always fail → after 3 retries the
// order is marked failed AND the stock is returned to the pool.
//
// Usage (worker must be started with FORCE_PAYMENT_FAIL=true):
//   docker compose exec -e FORCE_PAYMENT_FAIL=true worker \
//     sh -c 'kill 1'                # restart worker with the env var
//   docker compose exec api npx tsx src/scripts/orderFailureDemo.ts <productId>

import mongoose from "mongoose";
import { OrderModel } from "../models/Order.js";
import { signAccess } from "../auth/tokens.js";
import { UserModel } from "../models/User.js";
import { hashPassword } from "../auth/passwords.js";
import { redis } from "../db/redis.js";

const API_URL = process.env.INTERNAL_API_URL ?? "http://localhost:4000";
const MONGO_URI = process.env.MONGO_URI ?? "mongodb://mongo:27017/flashkart";

async function main() {
  const productId = process.argv[2];
  if (!productId) {
    console.error("usage: orderFailureDemo.ts <productId>");
    process.exit(1);
  }
  await mongoose.connect(MONGO_URI, { bufferCommands: false });

  const email = "pipeline-fail@flashkart.local";
  let user = await UserModel.findOne({ email });
  if (!user) {
    user = await UserModel.create({
      email,
      name: "Fail Demo",
      passwordHash: await hashPassword("not-used"),
      role: "buyer",
    });
  }
  const token = signAccess(user._id.toString(), user.role);

  const stockKey = `stock:${productId}`;
  const listBefore = await fetch(`${API_URL}/products`).then((r) => r.json());
  const stockBefore = listBefore.products.find((p: { _id: string }) => p._id === productId)?.stock ?? 0;
  console.log(`stock before: ${stockBefore}`);

  const buyRes = await fetch(`${API_URL}/products/${productId}/buy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ quantity: 1 }),
  });
  const buy = await buyRes.json();
  const stockDuring = Number(await redis.get(stockKey));
  console.log(`stock during: ${stockDuring}  (should be ${stockBefore - 1})`);
  console.log(`order: ${JSON.stringify(buy)}`);

  const orderId = buy.orderId;
  const deadline = Date.now() + 20_000;
  let last = "";
  while (Date.now() < deadline) {
    const o = await OrderModel.findById(orderId).lean();
    const s = o?.status ?? "?";
    if (s !== last) {
      console.log(`  status → ${s}  attempts=${o?.paymentAttempts ?? 0}`);
      last = s;
    }
    if (s === "confirmed" || s === "failed") break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Payment backoff is 500ms exp, 3 attempts → wait a bit past the last retry.
  await new Promise((r) => setTimeout(r, 500));

  const stockAfter = Number(await redis.get(stockKey));
  const final = await OrderModel.findById(orderId).lean();
  console.log(`\nfinal order status: ${final?.status}  reason=${final?.failureReason}`);
  console.log(`stock after       : ${stockAfter}  (should be ${stockBefore} — compensated)`);

  const pass = final?.status === "failed" && stockAfter === stockBefore;
  console.log(pass ? "\n>> PASS" : "\n>> FAIL");
  await mongoose.disconnect();
  redis.disconnect();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
