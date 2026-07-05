import type { Prisma, Order } from '@prisma/client';

type Tx = Prisma.TransactionClient;

interface FindOrderParams {
  orderId?: string | null;
  paymentIntentId?: string | null;
  sessionId?: string | null;
}

// 注文特定の優先順位(仕様書v1.5 7.3): metadata.order_id → stripe_payment_intent_id → stripe_session_id → 特定不能
export async function findOrderForEvent(tx: Tx, params: FindOrderParams): Promise<Order | null> {
  if (params.orderId) {
    const order = await tx.order.findUnique({ where: { id: params.orderId } });
    if (order) return order;
  }
  if (params.paymentIntentId) {
    const order = await tx.order.findFirst({ where: { stripePaymentIntentId: params.paymentIntentId } });
    if (order) return order;
  }
  if (params.sessionId) {
    const order = await tx.order.findFirst({ where: { stripeSessionId: params.sessionId } });
    if (order) return order;
  }
  return null;
}
