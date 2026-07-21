// Express app assembly — kept separate from the server bootstrap in `index.ts`
// so tests can import the app without spinning up a listener.

import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import cookieParser from "cookie-parser";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { healthRouter } from "./routes/health.js";
import { productsRouter } from "./routes/products.js";
import { reservationsRouter } from "./routes/reservations.js";
import { authRouter } from "./routes/auth.js";
import { ordersRouter } from "./routes/orders.js";
import { errorMiddleware } from "./middleware/error.js";
import { rateLimit } from "./rateLimit/middleware.js";

export function createApp() {
  const app = express();

  // Trust proxy — needed for correct req.ip when behind Nginx/ALB.
  // Interview-relevant: rate limiting keys on IP; wrong IP = wrong bucket.
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true, // for the refresh-token cookie in Phase 1b
    }),
  );
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  app.use("/health", healthRouter);
  // Global per-IP limiter — 60 req/min steady, 60-burst. Runs BEFORE route
  // handlers so all endpoints (except /health above) share this ceiling.
  app.use(rateLimit({ scope: "global", capacity: 60, refillPerSec: 1 }));
  app.use("/auth", authRouter);
  app.use("/products", productsRouter);
  app.use("/reservations", reservationsRouter);
  app.use("/orders", ordersRouter);

  // 404 for anything unmatched.
  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });

  app.use(errorMiddleware);

  return app;
}
