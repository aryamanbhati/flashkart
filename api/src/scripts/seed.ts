// Seeds a few flash-sale products so the UI has variety to play with.
// The "Sneakers" one is deliberately low-stock so you can easily click through
// to sold-out and see the failure state.
// Run: docker compose exec api npx tsx src/scripts/seed.ts

import mongoose from "mongoose";
import { ProductModel } from "../models/Product.js";

const MONGO_URI = process.env.MONGO_URI ?? "mongodb://mongo:27017/flashkart";

const SEED_PRODUCTS = [
  {
    name: "Wireless Earbuds",
    description: "Noise-cancelling. 30-hour battery. Lightning deal.",
    pricePaise: 199900, // ₹1,999
    stock: 50,
  },
  {
    name: "Smartwatch",
    description: "AMOLED display. Heart-rate + SpO2. Limited units.",
    pricePaise: 499900, // ₹4,999
    stock: 20,
  },
  {
    name: "Limited-Edition Sneakers",
    description: "Only a handful available. Grab before they're gone.",
    pricePaise: 599900, // ₹5,999
    stock: 5,
  },
];

async function main() {
  await mongoose.connect(MONGO_URI, { bufferCommands: false });
  const { redis } = await import("../db/redis.js");

  // Clear old demo products and their live Redis counters.
  const names = SEED_PRODUCTS.map((p) => p.name);
  const old = await ProductModel.find({ name: { $in: names } }).lean();
  for (const p of old) await redis.del(`stock:${p._id.toString()}`);
  await ProductModel.deleteMany({ name: { $in: names } });

  const created = await ProductModel.insertMany(SEED_PRODUCTS.map((p) => ({ ...p, active: true })));

  console.log("seeded products:");
  for (const p of created) {
    console.log(`  ${p._id.toString()}  ${p.stock.toString().padStart(3)} units  ${p.name}`);
  }
  console.log("\nopen: http://localhost:5173");

  await mongoose.disconnect();
  redis.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
