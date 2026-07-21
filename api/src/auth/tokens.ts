// JWT sign/verify. HS256 — one signing secret per token type. The two secrets
// are separated so that a leaked ACCESS secret cannot forge REFRESH tokens
// (and vice versa) — defence in depth.
//
// Payload contract:
//   Access:  { sub: userId, role, typ:"access" }
//   Refresh: { sub: userId, fam: familyId, typ:"refresh", jti }
//
// `typ` is checked on verify so a stolen access token can't be presented as a
// refresh token (a classic forgotten check).

import jwt, { type SignOptions } from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import type { Role } from "@flashkart/shared";

export type AccessPayload = { sub: string; role: Role; typ: "access" };
export type RefreshPayload = { sub: string; fam: string; typ: "refresh"; jti: string };

export function signAccess(userId: string, role: Role): string {
  const payload: AccessPayload = { sub: userId, role, typ: "access" };
  const opts: SignOptions = { algorithm: "HS256", expiresIn: env.JWT_ACCESS_TTL as SignOptions["expiresIn"] };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, opts);
}

export function signRefresh(userId: string, familyId: string): { token: string; jti: string } {
  const jti = randomUUID();
  const payload: RefreshPayload = { sub: userId, fam: familyId, typ: "refresh", jti };
  const opts: SignOptions = {
    algorithm: "HS256",
    expiresIn: env.JWT_REFRESH_TTL as SignOptions["expiresIn"],
  };
  const token = jwt.sign(payload, env.JWT_REFRESH_SECRET, opts);
  return { token, jti };
}

export function verifyAccess(token: string): AccessPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] }) as AccessPayload;
  if (decoded.typ !== "access") throw new Error("wrong token type");
  return decoded;
}

export function verifyRefresh(token: string): RefreshPayload {
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ["HS256"] }) as RefreshPayload;
  if (decoded.typ !== "refresh") throw new Error("wrong token type");
  return decoded;
}

// Convert `env.JWT_REFRESH_TTL` ("7d", "15m", etc.) to seconds for Redis EX and
// the cookie's Max-Age. Simple parser — matches the shapes we set in env.ts.
export function ttlToSeconds(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl);
  if (!m) throw new Error(`bad ttl: ${ttl}`);
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return n * mult;
}
