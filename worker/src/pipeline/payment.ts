// Payment stub. Simulates a real payment gateway:
//   * variable latency (200-500ms)
//   * ~10% random declines (throws → BullMQ retries with exponential backoff)
//   * FORCE_PAYMENT_FAIL env var makes it always fail (demo script uses this)

const FORCE_FAIL = process.env.FORCE_PAYMENT_FAIL === "true";

export async function chargePayment(orderId: string, totalPaise: number): Promise<void> {
  const latency = 200 + Math.random() * 300;
  await new Promise((r) => setTimeout(r, latency));

  if (FORCE_FAIL) throw new Error("payment declined (forced)");
  if (Math.random() < 0.1) throw new Error("payment declined (random 10%)");

  // In prod: hit Stripe/Razorpay, get a payment_intent_id, store it on the order.
  void orderId;
  void totalPaise;
}
