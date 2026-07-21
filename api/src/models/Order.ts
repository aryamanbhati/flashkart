// Order — the durable record of a purchase intent. Created the moment stock is
// committed; drives through the async pipeline in the worker.
//
// State machine:
//   pending    -> stock committed, payment not yet attempted
//   paid       -> payment authorized
//   fulfilled  -> warehouse pick/pack complete
//   confirmed  -> email sent → terminal happy state
//   failed     -> payment (or later step) exhausted retries → stock compensated
//
// Handlers MUST be idempotent: BullMQ delivers at-least-once. Every handler
// gates on the CURRENT status and no-ops if the order already moved past its
// gate — that way a duplicate delivery is safe.

import mongoose, { Schema, type InferSchemaType } from "mongoose";

export const ORDER_STATUS = [
  "pending",
  "paid",
  "fulfilled",
  "confirmed",
  "failed",
] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];

const orderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPricePaise: { type: Number, required: true, min: 0 },
    totalPaise: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ORDER_STATUS, required: true, default: "pending" },
    paymentAttempts: { type: Number, default: 0 },
    failureReason: { type: String },
  },
  { timestamps: true },
);

// Common query: "my orders, newest first".
orderSchema.index({ userId: 1, createdAt: -1 });

export type Order = InferSchemaType<typeof orderSchema> & { _id: mongoose.Types.ObjectId };

export const OrderModel = mongoose.model("Order", orderSchema);
