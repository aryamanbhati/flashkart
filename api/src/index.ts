// Process bootstrap. Order matters:
//   1. Validate env (crashes here if bad).
//   2. Connect to Mongo & Redis in parallel.
//   3. Start listening.
//   4. Install signal handlers for graceful shutdown.
//
// Graceful shutdown is the boring-but-critical part interviewers love.
// If a SIGTERM (K8s pod eviction) arrives mid-request, we want to:
//   - stop accepting new connections,
//   - let in-flight requests finish (with a timeout),
//   - close DB connections,
//   - THEN exit.
// Otherwise you leak connections and drop the tail of a rolling deploy's requests.

import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { connectMongo } from "./db/mongo.js";
import { redis } from "./db/redis.js";
import { createApp } from "./app.js";
import { attachRealtime } from "./realtime/socket.js";
import mongoose from "mongoose";

async function main() {
  await Promise.all([connectMongo(), redis.ping()]);

  const app = createApp();
  const server = app.listen(env.API_PORT, () => {
    logger.info({ port: env.API_PORT, env: env.NODE_ENV }, "api listening");
  });

  const realtime = attachRealtime(server);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutdown signal received");

    // 1. Stop accepting new connections.
    server.close((err) => {
      if (err) logger.error({ err }, "error closing http server");
    });

    // 2. Give in-flight requests up to 10s, then force-exit.
    const forceExit = setTimeout(() => {
      logger.warn("force-exiting after 10s shutdown timeout");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    // 3. Close DB connections + realtime.
    try {
      await realtime.close();
      await mongoose.disconnect();
      redis.disconnect();
    } catch (err) {
      logger.error({ err }, "error during shutdown");
    }

    logger.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandledRejection");
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException — exiting");
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, "boot failed");
  process.exit(1);
});
