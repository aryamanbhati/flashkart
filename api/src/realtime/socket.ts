// Socket.io server + Redis pub/sub bridge.
//
// The interesting bit: every api pod runs one Socket.io server AND one Redis
// subscriber. Any process — this pod, a sibling pod, or a worker — that
// PUBLISHes a StockEvent to STOCK_CHANNEL gets fanned out to every connected
// browser on every pod. This is the "scale sockets horizontally" pattern.
//
// Why a SEPARATE Redis connection for the subscriber:
// once a client issues SUBSCRIBE it enters subscriber mode and refuses normal
// commands until it UNSUBSCRIBEs. Sharing the main `redis` client with SUBSCRIBE
// would break every other operation (Lua, hashes, etc.).

import type { Server as HttpServer } from "node:http";
import { Server as IOServer } from "socket.io";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { STOCK_CHANNEL, ORDER_CHANNEL, type StockEvent, type OrderEvent } from "@flashkart/shared";
import { verifyAccess } from "../auth/tokens.js";

export type RealtimeHandle = {
  io: IOServer;
  close: () => Promise<void>;
};

export function attachRealtime(httpServer: HttpServer): RealtimeHandle {
  const io = new IOServer(httpServer, {
    cors: { origin: env.CORS_ORIGIN, credentials: true },
  });

  // Per-product rooms so a page showing only one product doesn't get every
  // event on the site. Clients emit `subscribe` with a productId to join.
  io.on("connection", (socket) => {
    socket.on("subscribe", (productId: unknown) => {
      if (typeof productId !== "string" || productId.length > 64) return;
      void socket.join(`product:${productId}`);
    });
    socket.on("unsubscribe", (productId: unknown) => {
      if (typeof productId !== "string") return;
      void socket.leave(`product:${productId}`);
    });
    // Order events are per-user. Client sends its access token to prove
    // identity; only the matching userId's room is joined. Never trust the
    // client's claim of userId — always derive it from a signed token.
    socket.on("subscribeOrders", (token: unknown) => {
      if (typeof token !== "string") return;
      try {
        const p = verifyAccess(token);
        void socket.join(`user:${p.sub}`);
      } catch {
        // ignore — bad token means no room join
      }
    });
  });

  // Dedicated subscriber connection. maxRetriesPerRequest:null keeps SUBSCRIBE
  // alive across reconnects (same reason BullMQ requires it).
  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  sub.on("error", (err) => logger.error({ err }, "realtime subscriber redis error"));

  sub.subscribe(STOCK_CHANNEL, ORDER_CHANNEL, (err, count) => {
    if (err) logger.error({ err }, "SUBSCRIBE failed");
    else logger.info({ channels: count }, "realtime: subscribed to channels");
  });

  sub.on("message", (channel, payload) => {
    if (channel === STOCK_CHANNEL) {
      let ev: StockEvent;
      try {
        ev = JSON.parse(payload) as StockEvent;
      } catch {
        return;
      }
      io.to(`product:${ev.productId}`).emit("stock", ev);
    } else if (channel === ORDER_CHANNEL) {
      let ev: OrderEvent;
      try {
        ev = JSON.parse(payload) as OrderEvent;
      } catch {
        return;
      }
      io.to(`user:${ev.userId}`).emit("order", ev);
    }
  });

  return {
    io,
    close: async () => {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      sub.disconnect();
    },
  };
}
