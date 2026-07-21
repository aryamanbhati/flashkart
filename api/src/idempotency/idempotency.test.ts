// Idempotency: same-key concurrent + serial retries must produce ONE real
// execution and identical replayed responses.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { withIdempotency } from "./idempotency.js";
import { resetState, teardown } from "../test/helpers.js";
import { randomUUID } from "node:crypto";

describe("withIdempotency", () => {
  beforeEach(async () => {
    await resetState();
  });

  afterAll(async () => {
    await teardown();
  });

  it("20 concurrent same-key calls → 1 real fn execution, 19 replayed", async () => {
    const key = randomUUID();
    let executions = 0;

    const runOne = () =>
      withIdempotency(key, async () => {
        executions++;
        // small artificial latency so racers actually queue on the lock
        await new Promise((r) => setTimeout(r, 30));
        return { status: 201, body: { executed: true } };
      });

    const results = await Promise.all(Array.from({ length: 20 }, runOne));

    expect(executions).toBe(1);
    const replayed = results.filter((r) => r.replayed).length;
    const original = results.filter((r) => !r.replayed).length;
    expect(original).toBe(1);
    expect(replayed).toBe(19);
    // All replays return exactly the same body.
    for (const r of results) expect(r.value.body).toEqual({ executed: true });
  });

  it("fn error releases the lock so a retry can succeed", async () => {
    const key = randomUUID();
    let calls = 0;

    await expect(
      withIdempotency(key, async () => {
        calls++;
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");

    // Second call with same key should run fn again (lock was released).
    const ok = await withIdempotency(key, async () => {
      calls++;
      return { status: 201, body: { ok: true } };
    });

    expect(calls).toBe(2);
    expect(ok.replayed).toBe(false);
  });
});
