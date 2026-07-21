// bcrypt wrapper. Cost 12 is a reasonable dev default (~250ms per hash on a
// laptop); in prod bump toward 13-14 as hardware improves. Cost sits inside
// the hash string so old hashes stay verifiable even when you raise the cost.

import bcrypt from "bcryptjs";

const HASH_COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, HASH_COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
