// The single most load-bearing test in this project: proves that N parallel
// purchase() calls against a product with stock S result in exactly min(N,S)
// successes and never exceed the stock. This is the correctness claim on the
// front page of the README.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { purchase } from "./inventory.js";
import { seedProduct, resetState, teardown } from "../test/helpers.js";

describe("inventory.purchase — atomic Lua decrement under concurrency", () => {
  beforeEach(async () => {
    await resetState();
  });

  afterAll(async () => {
    await teardown();
  });

  it("300 concurrent buys against stock=50 → exactly 50 ok, 250 sold_out, stock=0", async () => {
    const product = await seedProduct({ stock: 50 });
    const id = product._id.toString();

    const results = await Promise.all(
      Array.from({ length: 300 }, () => purchase(id, 1)),
    );

    const ok = results.filter((r) => r.status === "ok").length;
    const soldOut = results.filter((r) => r.status === "sold_out").length;

    expect(ok).toBe(50);
    expect(soldOut).toBe(250);
    // Every ok result must have a distinct `remaining` — no two decrements shared a value.
    const remainders = results
      .filter((r): r is { status: "ok"; remaining: number } => r.status === "ok")
      .map((r) => r.remaining)
      .sort((a, b) => a - b);
    expect(remainders).toEqual([...Array(50).keys()]); // [0,1,2,...,49]
  });

  it("returns not_found for a valid ObjectId that doesn't exist", async () => {
    const result = await purchase("507f1f77bcf86cd799439011", 1);
    expect(result.status).toBe("not_found");
  });

  it("respects quantity — one call for qty=5 removes 5, not 1", async () => {
    const product = await seedProduct({ stock: 10 });
    const result = await purchase(product._id.toString(), 5);
    expect(result).toEqual({ status: "ok", remaining: 5 });
  });

  it("qty larger than stock → sold_out (does not partially fulfil)", async () => {
    const product = await seedProduct({ stock: 3 });
    const result = await purchase(product._id.toString(), 5);
    expect(result.status).toBe("sold_out");
    // Stock must be untouched — no partial decrement.
    const check = await purchase(product._id.toString(), 3);
    expect(check).toEqual({ status: "ok", remaining: 0 });
  });
});
