// Model definitions duplicated here — same deliberate call as the Reservation
// model in sweeper.ts. Keeping worker and api as separately deployable units
// means no shared runtime dep on api. If these shapes drift, the tests and the
// TS compiler will scream — but the drift is a smell to catch in code review.

import mongoose, { Schema } from "mongoose";

const productSchema = new Schema(
  {
    name: String,
    description: String,
    pricePaise: Number,
    stock: Number,
    active: Boolean,
  },
  { timestamps: true },
);
export const ProductModel = mongoose.model("Product", productSchema);

const orderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    quantity: { type: Number, required: true },
    unitPricePaise: { type: Number, required: true },
    totalPaise: { type: Number, required: true },
    status: { type: String, required: true, default: "pending" },
    paymentAttempts: { type: Number, default: 0 },
    failureReason: { type: String },
  },
  { timestamps: true },
);
orderSchema.index({ userId: 1, createdAt: -1 });
export const OrderModel = mongoose.model("Order", orderSchema);

export const stockKey = (productId: string) => `stock:${productId}`;
