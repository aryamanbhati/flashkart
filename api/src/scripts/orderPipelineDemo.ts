// Happy-path proof: buy → order transitions pending → paid → fulfilled → confirmed.
//
// Run: docker compose exec api npx tsx src/scripts/orderPipelineDemo.ts <productId>

import mongoose from "mongoose";
import { OrderModel } from "../models/Order.js";
import { signAccess } from "../auth/tokens.js";
import { UserModel } from "../models/User.js";
import { hashPassword } from "../auth/passwords.js";

const API_URL = process.env.INTERNAL_API_URL ?? "http://localhost:4000";
const MONGO_URI = process.env.MONGO_URI ?? "mongodb://mongo:27017/flashkart";

async function main() {
  const productId = process.argv[2];
  if (!productId) {
    console.error("usage: orderPipelineDemo.ts <productId>");
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI, { bufferCommands: false });

  const email = "pipeline-demo@flashkart.local";
  let user = await UserModel.findOne({ email });
  if (!user) {
    user = await UserModel.create({
      email,
      name: "Pipeline Demo",
      passwordHash: await hashPassword("not-used"),
      role: "buyer",
    });
  }
  const token = signAccess(user._id.toString(), user.role);

  console.log("firing /buy…");
  const buyRes = await fetch(`${API_URL}/products/${productId}/buy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ quantity: 1 }),
  });
  const buy = await buyRes.json();
  console.log(`  ${buyRes.status}  ${JSON.stringify(buy)}`);
  if (buyRes.status !== 201) process.exit(1);

  const orderId = buy.orderId;
  const started = Date.now();
  const deadline = started + 15_000;
  let last = "";
  console.log("\npolling order status:");
  while (Date.now() < deadline) {
    const o = await OrderModel.findById(orderId).lean();
    const s = o?.status ?? "?";
    if (s !== last) {
      console.log(`  t=+${((Date.now() - started) / 1000).toFixed(2)}s  status=${s}`);
      last = s;
    }
    if (s === "confirmed" || s === "failed") break;
    await new Promise((r) => setTimeout(r, 50));
  }

  const final = await OrderModel.findById(orderId).lean();
  console.log(`\nfinal: ${final?.status}  totalPaise=${final?.totalPaise}  attempts=${final?.paymentAttempts}`);
  if (final?.status === "confirmed") console.log("\n>> PASS");
  else console.log("\n>> CHECK");

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
