// Orders — read side. The pipeline writes; this router only reads.

import { Router } from "express";
import mongoose from "mongoose";
import { badRequest, forbidden, notFound } from "@flashkart/shared";
import { OrderModel } from "../models/Order.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const ordersRouter = Router();

ordersRouter.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req, res) => {
    const orders = await OrderModel.find({ userId: req.user!.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ orders });
  }),
);

ordersRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw badRequest("invalid order id");
    const order = await OrderModel.findById(id).lean();
    if (!order) throw notFound("order not found");
    if (order.userId.toString() !== req.user!.id) throw forbidden("not your order");
    res.json({ order });
  }),
);
