// Shared test scaffolding: connect Mongo, get a Redis client, seed a product,
// mint a valid access token — so individual tests read as behaviour, not setup.

import mongoose from "mongoose";
import { connectMongo } from "../db/mongo.js";
import { redis } from "../db/redis.js";
import { ProductModel } from "../models/Product.js";
import { UserModel } from "../models/User.js";
import { OrderModel } from "../models/Order.js";
import { ReservationModel } from "../models/Reservation.js";
import { signAccess } from "../auth/tokens.js";
import { hashPassword } from "../auth/passwords.js";
import type { Role } from "@flashkart/shared";

let connected = false;
export async function ensureConnected() {
  if (connected) return;
  await connectMongo();
  await redis.ping();
  connected = true;
}

// Wipe the test DB + Redis logical DB between tests. Cheap because the test
// DB is small; safer than trying to reason about per-test data isolation.
export async function resetState() {
  await ensureConnected();
  await Promise.all([
    ProductModel.deleteMany({}),
    UserModel.deleteMany({}),
    OrderModel.deleteMany({}),
    ReservationModel.deleteMany({}),
  ]);
  await redis.flushdb();
}

export async function seedProduct(overrides: Partial<{ name: string; stock: number; pricePaise: number }> = {}) {
  const doc = await ProductModel.create({
    name: overrides.name ?? "Test Product",
    description: "test",
    pricePaise: overrides.pricePaise ?? 10000,
    stock: overrides.stock ?? 10,
    active: true,
  });
  return doc;
}

export async function seedUser(role: Role = "buyer") {
  const email = `t${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const user = await UserModel.create({
    email,
    name: "Test User",
    passwordHash: await hashPassword("not-used-in-tests"),
    role,
  });
  return { user, token: signAccess(user._id.toString(), role) };
}

export async function teardown() {
  await mongoose.disconnect();
  redis.disconnect();
}
