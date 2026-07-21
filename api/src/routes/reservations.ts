// Reservation state transitions: confirm (held -> confirmed) and release (held -> released).
// Both are single Mongo compare-and-set operations — the DB's atomicity is the
// arbiter for the race against the sweeper.

import { Router } from "express";
import mongoose from "mongoose";
import { badRequest, forbidden, notFound, reservationExpired } from "@flashkart/shared";
import { confirmReservation, releaseReservation } from "../inventory/inventory.js";
import { ReservationModel } from "../models/Reservation.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const reservationsRouter = Router();

// Only the owner (or admins in a future extension) can view a reservation.
// Prevents ID-enumeration attacks that would otherwise leak checkout state.
async function ensureOwner(id: string, userId: string) {
  const doc = await ReservationModel.findById(id).lean();
  if (!doc) throw notFound("reservation not found");
  if (doc.userId && doc.userId.toString() !== userId) throw forbidden("not your reservation");
  return doc;
}

reservationsRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw badRequest("invalid reservation id");
    const doc = await ensureOwner(id, req.user!.id);
    res.json({ reservation: doc });
  }),
);

reservationsRouter.post(
  "/:id/confirm",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw badRequest("invalid reservation id");
    await ensureOwner(id, req.user!.id);
    const result = await confirmReservation(id);
    if (result.status === "not_found") throw notFound("reservation not found");
    if (result.status === "expired") throw reservationExpired();
    res.status(200).json({
      status: "confirmed",
      reservationId: id,
      productId: result.productId,
      quantity: result.quantity,
    });
  }),
);

reservationsRouter.post(
  "/:id/release",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw badRequest("invalid reservation id");
    await ensureOwner(id, req.user!.id);
    const result = await releaseReservation(id);
    if (result.status === "not_found") throw notFound("reservation not found");
    if (result.status === "not_holdable") {
      // Already confirmed/expired/released — treat as a no-op success.
      res.status(200).json({ status: "already_terminal" });
      return;
    }
    res.status(200).json({
      status: "released",
      reservationId: id,
      productId: result.productId,
      quantity: result.quantity,
    });
  }),
);
