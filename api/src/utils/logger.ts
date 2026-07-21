// Pino: structured JSON logging. Two reasons this matters for a "system design"-y project:
//   1. Every log line is a JSON object with req_id, msg, level — trivial to ship to
//      Loki/Elasticsearch/CloudWatch in prod. Interviewers ask "how would you debug
//      an issue in prod?" and the answer starts with structured logs + correlation IDs.
//   2. `pino-http` auto-injects a req.id into every request-scoped log, so you can
//      trace one buyer's request across multiple log lines.
//
// In dev we use `pino-pretty`-style output via transport for readability; in prod
// we emit raw JSON.

import pino from "pino";
import { env } from "../config/env.js";

export const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  ...(env.NODE_ENV !== "production"
    ? {
        transport: {
          target: "pino/file",
          options: { destination: 1 }, // stdout
        },
      }
    : {}),
});
