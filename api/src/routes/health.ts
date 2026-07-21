// Two endpoints, both essential for containerized systems:
//
//   /health/live    — "is the process alive?" — used by Kubernetes livenessProbe.
//                     Returns 200 if the event loop is responsive. Does NOT check
//                     downstream deps, because if Mongo is down we DON'T want K8s
//                     to restart every api pod — that just amplifies the outage.
//
//   /health/ready   — "am I ready to serve traffic?" — used by K8s readinessProbe.
//                     Checks mongo + redis. If either is down, we return 503 so
//                     the load balancer pulls this pod out of rotation until deps
//                     recover.
//
// This live/ready split is a standard interview talking point.

import { Router } from "express";
import { mongoIsConnected } from "../db/mongo.js";
import { pingRedis } from "../db/redis.js";
import { asyncHandler } from "../middleware/error.js";

export const healthRouter = Router();

healthRouter.get("/live", (_req, res) => {
  res.json({ status: "ok" });
});

healthRouter.get(
  "/ready",
  asyncHandler(async (_req, res) => {
    const mongoOk = mongoIsConnected();
    const redisOk = await pingRedis();
    const allOk = mongoOk && redisOk;

    res.status(allOk ? 200 : 503).json({
      status: allOk ? "ok" : "degraded",
      checks: {
        mongo: mongoOk ? "ok" : "down",
        redis: redisOk ? "ok" : "down",
      },
    });
  }),
);
