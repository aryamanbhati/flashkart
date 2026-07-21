// Mongoose connection. Called once from index.ts at startup.
//
// A few production-minded touches worth understanding:
//
//   `bufferCommands: false` — Mongoose by default queues commands issued before
//   the connection is ready and flushes them on connect. That hides bugs where
//   you accidentally query before connecting. We'd rather crash loudly.
//
//   `autoIndex` off in production — index creation runs on connect. On a large
//   collection that's a stall; you want it happening at deploy time, not startup.
//
//   The `strictQuery: true` setting (default in Mongoose 7+) throws on unknown
//   fields in queries — again, prefer loud failures.

import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

mongoose.set("strictQuery", true);

export async function connectMongo(): Promise<void> {
  mongoose.connection.on("error", (err) => {
    logger.error({ err }, "mongo connection error");
  });
  mongoose.connection.on("disconnected", () => {
    logger.warn("mongo disconnected");
  });

  await mongoose.connect(env.MONGO_URI, {
    bufferCommands: false,
    autoIndex: env.NODE_ENV !== "production",
    serverSelectionTimeoutMS: 5000,
  });

  logger.info({ uri: redactUri(env.MONGO_URI) }, "mongo connected");
}

export function mongoIsConnected(): boolean {
  // 1 = connected. See mongoose.ConnectionStates.
  return mongoose.connection.readyState === 1;
}

// Never log a full URI — it may contain credentials in production.
function redactUri(uri: string): string {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
}
