// Mint an access token for load-test scripts. Uses the same signing secret as
// the running api. Prints the token to stdout for shell capture.
//
// Run: docker compose exec api npx tsx src/scripts/mintTestToken.ts [role]

import mongoose from "mongoose";
import { UserModel } from "../models/User.js";
import { signAccess } from "../auth/tokens.js";
import { hashPassword } from "../auth/passwords.js";
import type { Role } from "@flashkart/shared";

const MONGO_URI = process.env.MONGO_URI ?? "mongodb://mongo:27017/flashkart";

async function main() {
  const role = (process.argv[2] ?? "buyer") as Role;
  await mongoose.connect(MONGO_URI, { bufferCommands: false });

  const email = `loadtest+${role}@flashkart.local`;
  let user = await UserModel.findOne({ email });
  if (!user) {
    user = await UserModel.create({
      email,
      name: `Load Test (${role})`,
      passwordHash: await hashPassword("not-used-only-for-scripts"),
      role,
    });
  }

  const token = signAccess(user._id.toString(), user.role);
  process.stdout.write(token);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
