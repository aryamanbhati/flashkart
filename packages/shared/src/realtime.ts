// Shared shape of realtime events. Both api and worker publish; both
// need the same channel name and JSON schema.

export const STOCK_CHANNEL = "flashkart:stock";

export type StockEventReason = "purchase" | "reserve" | "release" | "sweep_expired";

export type StockEvent = {
  productId: string;
  remaining: number;
  reason: StockEventReason;
  ts: number; // publisher's wall clock — clients can drop obviously stale events
};
