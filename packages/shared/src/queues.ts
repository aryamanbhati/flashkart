// Shared queue names + job payload shapes. Both api (producer) and worker
// (consumer) import these so a rename or field change breaks both sides at
// compile time — the class of bug where a producer sends {orderId} and a
// consumer expects {order_id} is impossible.

// BullMQ v5 disallows ':' in queue names (colon is its own key-separator).
// Underscores are safe and still readable.
export const QUEUE_ORDERS_PROCESS = "orders_process";
export const QUEUE_ORDERS_FULFILL = "orders_fulfill";
export const QUEUE_ORDERS_NOTIFY = "orders_notify";

export type ProcessOrderJob = { orderId: string };
export type FulfillOrderJob = { orderId: string };
export type NotifyOrderJob = { orderId: string };

// Realtime channel + event shape for order status broadcasts.
export const ORDER_CHANNEL = "flashkart:orders";

export type OrderEvent = {
  orderId: string;
  userId: string;
  status: "pending" | "paid" | "fulfilled" | "confirmed" | "failed";
  ts: number;
};
