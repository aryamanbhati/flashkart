// A short-lived hold on stock — the "seat" in the seat-lock pattern.
//
// Lifecycle:
//   held      -> initial state; stock is decremented from the Redis pool
//   confirmed -> user completed checkout in time; becomes a real order
//   expired   -> TTL passed before confirm; sweeper returns stock to the pool
//   released  -> user explicitly cancelled; sweeper returns stock immediately
//
// The `status` field is the arbiter for the confirm-vs-sweep race. Every state
// transition is a Mongo `findOneAndUpdate` that predicates on the SOURCE status,
// so a concurrent flip in the other direction fails cleanly.

import mongoose, { Schema, type InferSchemaType } from "mongoose";

export const RESERVATION_STATUS = ["held", "confirmed", "expired", "released"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUS)[number];

const reservationSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: false, index: true },
    quantity: { type: Number, required: true, min: 1 },
    status: { type: String, enum: RESERVATION_STATUS, required: true, default: "held" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// The sweeper's hot query: held reservations whose TTL has passed.
reservationSchema.index({ status: 1, expiresAt: 1 });

export type Reservation = InferSchemaType<typeof reservationSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const ReservationModel = mongoose.model("Reservation", reservationSchema);
