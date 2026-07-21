// Reservation state machine: the confirm-vs-sweep race is the interesting
// property to prove. Only one branch can win, and stock accounting must be
// exactly right in either branch.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  confirmReservation,
  releaseReservation,
  reserve,
  sweepExpiredReservations,
} from "./inventory.js";
import { ReservationModel } from "../models/Reservation.js";
import { redis } from "../db/redis.js";
import { resetState, seedProduct, teardown } from "../test/helpers.js";

describe("reservation state machine", () => {
  beforeEach(async () => {
    await resetState();
  });

  afterAll(async () => {
    await teardown();
  });

  it("reserve → confirm keeps stock deducted (no phantom refund)", async () => {
    const product = await seedProduct({ stock: 5 });
    const id = product._id.toString();

    const r = await reserve(id, 1);
    expect(r.status).toBe("held");
    expect(await redis.get(`stock:${id}`)).toBe("4");

    if (r.status !== "held") throw new Error();
    const c = await confirmReservation(r.reservationId);
    expect(c.status).toBe("confirmed");
    expect(await redis.get(`stock:${id}`)).toBe("4"); // still 4, no refund
  });

  it("reserve → expire → sweeper returns stock, then confirm → 'expired'", async () => {
    const product = await seedProduct({ stock: 5 });
    const id = product._id.toString();

    const r = await reserve(id, 1);
    if (r.status !== "held") throw new Error();

    await ReservationModel.updateOne(
      { _id: r.reservationId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const reclaimed = await sweepExpiredReservations();
    expect(reclaimed).toBe(1);
    expect(await redis.get(`stock:${id}`)).toBe("5"); // returned

    const c = await confirmReservation(r.reservationId);
    expect(c.status).toBe("expired");
  });

  it("release returns stock to the pool", async () => {
    const product = await seedProduct({ stock: 5 });
    const id = product._id.toString();
    const r = await reserve(id, 2);
    if (r.status !== "held") throw new Error();

    expect(await redis.get(`stock:${id}`)).toBe("3");
    const rel = await releaseReservation(r.reservationId);
    expect(rel.status).toBe("released");
    expect(await redis.get(`stock:${id}`)).toBe("5");
  });

  it("race: confirm and sweeper on an expired hold — exactly one wins", async () => {
    // Run this many times because it's a race — one iteration might miss the
    // interesting interleaving. 20 runs makes it near-certain we catch both.
    const product = await seedProduct({ stock: 20 });
    const id = product._id.toString();

    for (let i = 0; i < 20; i++) {
      const r = await reserve(id, 1);
      if (r.status !== "held") throw new Error();

      await ReservationModel.updateOne(
        { _id: r.reservationId },
        { $set: { expiresAt: new Date(Date.now() - 1) } },
      );

      const [confirmResult, reclaimed] = await Promise.all([
        confirmReservation(r.reservationId),
        sweepExpiredReservations(),
      ]);

      const doc = await ReservationModel.findById(r.reservationId).lean();

      // Exactly one of {confirmed, expired} wins.
      if (confirmResult.status === "confirmed") {
        expect(doc?.status).toBe("confirmed");
        expect(reclaimed).toBe(0);
      } else {
        expect(confirmResult.status).toBe("expired");
        expect(doc?.status).toBe("expired");
        expect(reclaimed).toBe(1);
      }
    }
  });
});
