// Access-token verifier. Attaches `req.user = {id, role}` on success.
// Reads `Authorization: Bearer <token>`. If missing or invalid, returns 401.
//
// The role check middleware `requireRole` runs AFTER requireAuth in a chain.

import type { Request, RequestHandler } from "express";
import { forbidden, unauthenticated, type Role } from "@flashkart/shared";
import { verifyAccess } from "../auth/tokens.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; role: Role };
    }
  }
}

function extractBearer(req: Request): string | null {
  const h = req.header("Authorization");
  if (!h) return null;
  const [scheme, token] = h.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = extractBearer(req);
  if (!token) return next(unauthenticated("missing access token"));
  try {
    const payload = verifyAccess(token);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    next(unauthenticated("invalid or expired access token"));
  }
};

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthenticated());
    if (!roles.includes(req.user.role)) return next(forbidden("insufficient role"));
    next();
  };
}
