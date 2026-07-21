// One place where all thrown errors turn into JSON responses.
// Express does not natively await async handlers, so we ALSO export `asyncHandler`
// to wrap route handlers — without it, a thrown error in an async handler
// becomes an unhandled rejection and the response hangs.

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError, ERROR_CODES } from "@flashkart/shared";
import { logger } from "../utils/logger.js";

export const asyncHandler =
  <T extends RequestHandler>(fn: T): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    // Domain errors — expected. Log at info/warn, not error.
    logger.warn({ code: err.code, path: req.path }, err.message);
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // Everything else = bug. Full stack, 500.
  logger.error({ err, path: req.path }, "unhandled error");
  res.status(500).json({
    error: { code: ERROR_CODES.INTERNAL, message: "Internal error" },
  });
}
