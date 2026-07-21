// Auth surface: register, login, refresh, logout, me.
//
// Refresh token flow:
//   * Issued on login as an httpOnly Secure(prod) SameSite=Lax cookie called
//     `frt`. JS on the page cannot read it — XSS-resistant by design.
//   * `/auth/refresh` reads the cookie, verifies signature + typ, checks its
//     JTI against the family's active JTI in Redis. If it doesn't match →
//     REUSE → nuke the family and reject.
//   * On success, mint a new access + new refresh (new JTI), update Redis,
//     re-set the cookie. Rotation.
//
// Access token: returned in the JSON body on login/refresh. Client keeps it
// in memory (React state), NOT localStorage — localStorage is XSS-readable.

import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { badRequest, conflict, unauthenticated, notFound } from "@flashkart/shared";
import { UserModel } from "../models/User.js";
import { asyncHandler } from "../middleware/error.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import {
  signAccess,
  signRefresh,
  verifyRefresh,
  ttlToSeconds,
} from "../auth/tokens.js";
import { getActiveJti, revokeFamily, saveActiveJti } from "../auth/refreshStore.js";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { rateLimit } from "../rateLimit/middleware.js";

export const authRouter = Router();

const REFRESH_COOKIE = "frt";
const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/auth", // only sent to /auth/* — smaller attack surface
  maxAge: ttlToSeconds(env.JWT_REFRESH_TTL) * 1000,
});

const registerSchema = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(80),
  password: z.string().min(8).max(200),
});

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

// Stricter limit on auth to slow down credential-stuffing bots.
// 10 attempts per minute per IP is generous for humans, tight for bots.
const authLimiter = rateLimit({ scope: "auth", capacity: 10, refillPerSec: 10 / 60 });

authRouter.post(
  "/register",
  authLimiter,
  asyncHandler(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("invalid input", parsed.error.issues);
    const { email, name, password } = parsed.data;

    const existing = await UserModel.findOne({ email }).lean();
    if (existing) throw conflict("email already registered");

    const passwordHash = await hashPassword(password);
    const user = await UserModel.create({ email, name, passwordHash, role: "buyer" });

    res.status(201).json({
      user: { id: user._id.toString(), email: user.email, name: user.name, role: user.role },
    });
  }),
);

authRouter.post(
  "/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("invalid input", parsed.error.issues);
    const { email, password } = parsed.data;

    // .select("+passwordHash") because the schema hides it by default.
    const user = await UserModel.findOne({ email }).select("+passwordHash");
    if (!user || !user.active) throw unauthenticated("invalid credentials");

    const ok = await verifyPassword(password, user.passwordHash);
    // Same error for missing-user and wrong-password so attackers can't
    // enumerate valid emails via response timing/text.
    if (!ok) throw unauthenticated("invalid credentials");

    const userId = user._id.toString();
    const familyId = randomUUID();
    const accessToken = signAccess(userId, user.role);
    const { token: refreshToken, jti } = signRefresh(userId, familyId);
    await saveActiveJti(userId, familyId, jti, ttlToSeconds(env.JWT_REFRESH_TTL));

    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());
    res.json({
      accessToken,
      user: { id: userId, email: user.email, name: user.name, role: user.role },
    });
  }),
);

authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw unauthenticated("no refresh token");

    let payload;
    try {
      payload = verifyRefresh(token);
    } catch {
      throw unauthenticated("invalid refresh token");
    }

    const active = await getActiveJti(payload.sub, payload.fam);
    if (!active) throw unauthenticated("session revoked");

    // The critical check: if the JTI on the token isn't the currently-active
    // one, this token is stale (already rotated) — treat as reuse and nuke.
    if (active !== payload.jti) {
      await revokeFamily(payload.sub, payload.fam);
      throw unauthenticated("refresh token reuse detected — session revoked");
    }

    const user = await UserModel.findById(payload.sub).lean();
    if (!user || !user.active) {
      await revokeFamily(payload.sub, payload.fam);
      throw unauthenticated("user inactive");
    }

    // Rotate.
    const newAccess = signAccess(payload.sub, user.role);
    const { token: newRefresh, jti: newJti } = signRefresh(payload.sub, payload.fam);
    await saveActiveJti(payload.sub, payload.fam, newJti, ttlToSeconds(env.JWT_REFRESH_TTL));

    res.cookie(REFRESH_COOKIE, newRefresh, refreshCookieOptions());
    res.json({
      accessToken: newAccess,
      user: { id: payload.sub, email: user.email, name: user.name, role: user.role },
    });
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) {
      try {
        const payload = verifyRefresh(token);
        await revokeFamily(payload.sub, payload.fam);
      } catch {
        // Ignore — even a bad token results in a clean logout for the client.
      }
    }
    res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: 0 });
    res.json({ ok: true });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await UserModel.findById(req.user!.id).lean();
    if (!user) throw notFound("user not found");
    res.json({
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  }),
);
