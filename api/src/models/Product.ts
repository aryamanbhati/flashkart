// The permanent record of a product — lives in Mongo (the filing cabinet).
//
// `stock` here is the CATALOG / starting stock. During a live sale the fast,
// authoritative live count lives in Redis (the whiteboard); this field is the
// number we prime Redis from on first touch, and the number a background job
// will reconcile back to later (Phase 5).
//
// Money note: we store price as an INTEGER number of paise (1 rupee = 100 paise),
// never as a floating-point rupee value. Floats can't represent 0.10 exactly, so
// summing money as floats drifts. Every serious payments system stores minor units
// as integers — a small thing interviewers at Amex-type shops notice.

import mongoose, { Schema, type InferSchemaType } from "mongoose";

const productSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    pricePaise: { type: Number, required: true, min: 0 },
    stock: { type: Number, required: true, min: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type Product = InferSchemaType<typeof productSchema> & { _id: mongoose.Types.ObjectId };

export const ProductModel = mongoose.model("Product", productSchema);
