// Refresh-token family tracking in Redis.
//
// Concepts:
//   * A "family" is one login session. Rotation replaces one JTI (JWT ID) with
//     the next within a family; the family survives across rotations.
//   * The active JTI is stored under key `refresh:<userId>:<familyId>` with a
//     TTL matching the refresh token's expiry — no cron needed.
//   * REUSE DETECTION: if the client presents a refresh token whose JTI is not
//     the currently-stored one for its family, we assume the token was stolen
//     and delete the whole family. All sessions in that family are dead.
//
// This is the OAuth 2.0 Security BCP "refresh token rotation with automatic
// reuse detection" pattern.

import { redis } from "../db/redis.js";

const familyKey = (userId: string, familyId: string) => `refresh:${userId}:${familyId}`;

export async function saveActiveJti(
  userId: string,
  familyId: string,
  jti: string,
  ttlSeconds: number,
): Promise<void> {
  await redis.set(familyKey(userId, familyId), jti, "EX", ttlSeconds);
}

export async function getActiveJti(userId: string, familyId: string): Promise<string | null> {
  return await redis.get(familyKey(userId, familyId));
}

// Nuke the family. Called on reuse detection AND on logout.
export async function revokeFamily(userId: string, familyId: string): Promise<void> {
  await redis.del(familyKey(userId, familyId));
}
