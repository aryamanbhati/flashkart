import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { badRequest, notFound, soldOut } from "@flashkart/shared";
import { ProductModel } from "../models/Product.js";
import { OrderModel } from "../models/Order.js";
import { getLiveStock, purchase, reserve } from "../inventory/inventory.js";
import { redis } from "../db/redis.js";
import { asyncHandler } from "../middleware/error.js";
import { withIdempotency } from "../idempotency/idempotency.js";
import { rateLimit } from "../rateLimit/middleware.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { enqueueProcessOrder } from "../queues/producers.js";
import { logger } from "../utils/logger.js";

// Money endpoints: 5 requests per 10s per authenticated user (falls back to IP
// only if unauthenticated, but these routes now require auth anyway).
// Keying on userId means a shared office IP doesn't rate-limit the whole team.
const buyLimiter = rateLimit({
  scope: "buy",
  capacity: 5,
  refillPerSec: 0.5,
  keyOf: (req) => req.user?.id ?? req.ip ?? null,
});

// Loose UUID-ish shape — reject obvious garbage without being pedantic about v4 vs v7.
const IDEM_KEY_RE = /^[a-zA-Z0-9_-]{8,128}$/;

export const productsRouter = Router();

// GET /products — catalog list (stock shown is the Mongo catalog value).
productsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const products = await ProductModel.find({ active: true }).lean();
    // Overlay Redis live counters where present. One MGET, not N GETs — hot-path safe.
    const keys = products.map((p) => `stock:${p._id.toString()}`);
    const live = keys.length ? await redis.mget(...keys) : [];
    const merged = products.map((p, i) => ({
      ...p,
      stock: live[i] !== null ? Number(live[i]) : p.stock,
    }));
    res.json({ products: merged });
  }),
);

// GET /products/:id — single product with the LIVE stock (from Redis if primed).
productsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw badRequest("invalid product id");

    const product = await ProductModel.findById(id).lean();
    if (!product || !product.active) throw notFound("product not found");

    const liveStock = await getLiveStock(id);
    res.json({ product: { ...product, liveStock } });
  }),
);

// POST /products/:id/buy — the atomic, no-oversell purchase.
// Body: { "quantity": 1 }  (optional, defaults to 1)
const buyBodySchema = z.object({
  quantity: z.coerce.number().int().positive().max(10).default(1),
});

productsRouter.post(
  "/:id/buy",
  requireAuth,
  buyLimiter,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw badRequest("invalid product id");

    const parsed = buyBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("invalid quantity", parsed.error.issues);
    const { quantity } = parsed.data;

    const rawKey = req.header("Idempotency-Key");
    if (rawKey !== undefined && !IDEM_KEY_RE.test(rawKey)) {
      throw badRequest("invalid Idempotency-Key");
    }
    // Namespace by product AND userId so different users using coincidentally-
    // matching keys don't collide, and a key reused across products doesn't
    // cross-contaminate.
    const idemKey = rawKey ? `buy:${req.user!.id}:${id}:${rawKey}` : null;

    const doPurchase = async () => {
      const result = await purchase(id, quantity);
      if (result.status === "not_found") throw notFound("product not found");
      if (result.status === "sold_out") throw soldOut("sold out");

      // Look up unit price from Mongo — we need it for the order total.
      // Kept off the hot path deliberately: this only fires on successful buys.
      const product = await ProductModel.findById(id).lean();
      const unitPricePaise = product?.pricePaise ?? 0;

      // Persist the order BEFORE enqueueing. If the enqueue fails, we'd rather
      // have an orphan "pending" order (visible in admin dashboards, recoverable
      // by a reconciliation sweep) than an enqueued job with no durable record.
      const order = await OrderModel.create({
        userId: req.user!.id,
        productId: id,
        quantity,
        unitPricePaise,
        totalPaise: unitPricePaise * quantity,
        status: "pending",
      });

      try {
        await enqueueProcessOrder(order._id.toString());
      } catch (err) {
        // Failed to enqueue but stock is decremented and order is pending. A
        // periodic recovery sweep can find pending orders older than N minutes
        // and re-enqueue them. Log loudly for now.
        logger.error({ err, orderId: order._id.toString() }, "enqueue failed");
      }

      return {
        status: 201,
        body: {
          status: "pending" as const,
          orderId: order._id.toString(),
          productId: id,
          quantity,
          remaining: result.remaining,
        },
      };
    };

    if (!idemKey) {
      const r = await doPurchase();
      res.status(r.status).json(r.body);
      return;
    }

    const { replayed, value } = await withIdempotency(idemKey, doPurchase);
    res.setHeader("Idempotent-Replay", replayed ? "true" : "false");
    res.status(value.status).json(value.body);
  }),
);

// POST /products/:id/reserve — hold stock for RESERVATION_TTL_MS while user checks out.
// Same idempotency wiring as /buy so a double-click makes ONE reservation.
productsRouter.post(
  "/:id/reserve",
  requireAuth,
  buyLimiter,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw badRequest("invalid product id");

    const parsed = buyBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest("invalid quantity", parsed.error.issues);
    const { quantity } = parsed.data;

    const rawKey = req.header("Idempotency-Key");
    if (rawKey !== undefined && !IDEM_KEY_RE.test(rawKey)) {
      throw badRequest("invalid Idempotency-Key");
    }
    const idemKey = rawKey ? `reserve:${req.user!.id}:${id}:${rawKey}` : null;

    const doReserve = async () => {
      const result = await reserve(id, quantity, req.user!.id);
      if (result.status === "not_found") throw notFound("product not found");
      if (result.status === "sold_out") throw soldOut("sold out");
      return {
        status: 201,
        body: {
          status: "held" as const,
          reservationId: result.reservationId,
          productId: id,
          quantity,
          expiresAt: result.expiresAt.toISOString(),
          remaining: result.remaining,
        },
      };
    };

    if (!idemKey) {
      const r = await doReserve();
      res.status(r.status).json(r.body);
      return;
    }

    const { replayed, value } = await withIdempotency(idemKey, doReserve);
    res.setHeader("Idempotent-Replay", replayed ? "true" : "false");
    res.status(value.status).json(value.body);
  }),
);
