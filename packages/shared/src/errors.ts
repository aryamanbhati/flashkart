// A minimal application-error taxonomy shared by api and worker.
// Why bother: our HTTP error middleware and the worker's job-error handler both
// need to distinguish "user's fault, don't retry" from "our fault, retry with backoff"
// from "sold out, this is not an error, it's an outcome". A shared enum keeps them in sync.

export const ERROR_CODES = {
  // 4xx — client's fault
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",

  // Domain outcomes — not errors in the "bug" sense, but they surface as non-2xx
  SOLD_OUT: "SOLD_OUT",
  RESERVATION_EXPIRED: "RESERVATION_EXPIRED",
  IDEMPOTENCY_REPLAY: "IDEMPOTENCY_REPLAY",

  // 5xx — our fault
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// Convenience constructors — keep call sites readable.
export const badRequest = (msg: string, details?: unknown) =>
  new AppError(ERROR_CODES.BAD_REQUEST, msg, 400, details);
export const unauthenticated = (msg = "Not authenticated") =>
  new AppError(ERROR_CODES.UNAUTHENTICATED, msg, 401);
export const forbidden = (msg = "Forbidden") => new AppError(ERROR_CODES.FORBIDDEN, msg, 403);
export const notFound = (msg = "Not found") => new AppError(ERROR_CODES.NOT_FOUND, msg, 404);
export const conflict = (msg: string) => new AppError(ERROR_CODES.CONFLICT, msg, 409);
export const soldOut = (msg = "Sold out") => new AppError(ERROR_CODES.SOLD_OUT, msg, 409);
export const reservationExpired = (msg = "Reservation expired") =>
  new AppError(ERROR_CODES.RESERVATION_EXPIRED, msg, 410);
export const rateLimited = (msg = "Too many requests") =>
  new AppError(ERROR_CODES.RATE_LIMITED, msg, 429);
export const internal = (msg = "Internal error", details?: unknown) =>
  new AppError(ERROR_CODES.INTERNAL, msg, 500, details);
