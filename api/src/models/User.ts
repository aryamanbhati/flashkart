// User — auth identity + role for authorization.
//
// Never store the plaintext password. `passwordHash` is a bcrypt digest; the
// only way to check a login is `bcrypt.compare(input, hash)` — the hash never
// reveals the original. On response payloads we omit the hash via .toObject() /
// explicit picks so it doesn't leak through misuse.

import mongoose, { Schema, type InferSchemaType } from "mongoose";
import { ROLES } from "@flashkart/shared";

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true, select: false }, // omitted from default queries
    role: { type: String, enum: ROLES, required: true, default: "buyer" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type User = InferSchemaType<typeof userSchema> & { _id: mongoose.Types.ObjectId };

export const UserModel = mongoose.model("User", userSchema);
