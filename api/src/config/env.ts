// Env validation at boot. If the shape is wrong, we crash with a useful message
// BEFORE any code that would fail cryptically 200ms later (mongoose.connect,
// jsonwebtoken.sign, etc.).
//
// Zod is used instead of hand-rolling checks because it gives us:
//   - a parsed, TYPED config object (env.MONGO_URI is `string`, not `string | undefined`)
//   - one error report listing every missing/malformed var, not just the first
//
// Import this module for its side effects at the very top of `index.ts`.

import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Railway / Fly / Render / most PaaS pass `PORT`; local dev uses `API_PORT`.
  // Prefer PORT when set, fall back to API_PORT, fall back to 4000.
  PORT: z.coerce.number().int().positive().optional(),
  API_PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().url().default("http://localhost:5173"),

  MONGO_URI: z.string().min(1, "MONGO_URI is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  JWT_ACCESS_SECRET: z.string().min(16, "JWT_ACCESS_SECRET must be at least 16 chars"),
  JWT_REFRESH_SECRET: z.string().min(16, "JWT_REFRESH_SECRET must be at least 16 chars"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("7d"),

  // Shared secret that lets internal scripts (buyStorm, load tests) skip rate
  // limiting. Empty in prod = bypass disabled. Non-empty in dev/staging = allowed.
  RATE_LIMIT_BYPASS_TOKEN: z.string().default(""),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("❌ Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
