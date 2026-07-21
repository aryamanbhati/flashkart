// Express middleware factory for a token-bucket rate limit.
//
// Usage:
//   app.use(rateLimit({ scope: "global", capacity: 60, refillPerSec: 1 }));
//   productsRouter.post("/:id/buy", rateLimit({ scope: "buy", capacity: 5, refillPerSec: 0.5 }), handler);
//
// The identity used per bucket is req.ip. `trust proxy: 1` in app.ts ensures
// this is the real client IP behind a load balancer.

import type { RequestHandler } from "express";
import { checkRate } from "./tokenBucket.js";
import { logger } from "../utils/logger.js";
import { env } from "../config/env.js";

export type RateLimitOptions = {
  scope: string;
  capacity: number;
  refillPerSec: number;
  cost?: number;
  // Optional: override the identity. Default is req.ip.
  keyOf?: (req: Parameters<RequestHandler>[0]) => string | null;
};

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const { scope, capacity, refillPerSec, cost = 1, keyOf } = opts;

  return async (req, res, next) => {
    try {
      // Internal-test / load-test bypass. Only honoured when a token is set
      // in env (empty by default → disabled in prod).
      if (env.RATE_LIMIT_BYPASS_TOKEN) {
        const provided = req.header("X-RateLimit-Bypass");
        if (provided && provided === env.RATE_LIMIT_BYPASS_TOKEN) return next();
      }

      const id = keyOf ? keyOf(req) : req.ip;
      // Fail-open on missing identity — better UX than 500ing every request
      // if a proxy misconfig strips req.ip.
      if (!id) return next();

      const key = `rl:${scope}:${id}`;
      const decision = await checkRate(key, capacity, refillPerSec, cost);

      res.setHeader("X-RateLimit-Limit", String(capacity));
      res.setHeader("X-RateLimit-Remaining", String(Math.max(0, decision.remaining)));

      if (!decision.allowed) {
        const retryAfterSec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
        res.setHeader("Retry-After", String(retryAfterSec));
        res.status(429).json({
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests",
            retryAfterMs: decision.retryAfterMs,
          },
        });
        return;
      }

      next();
    } catch (err) {
      // Fail-open on Redis blips — an overloaded Redis shouldn't 500 every
      // request. Log loud, let the request through.
      logger.warn({ err, scope }, "rate limit check failed — allowing request");
      next();
    }
  };
}
