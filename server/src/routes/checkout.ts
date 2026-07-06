import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { sendError } from '../lib/apiError';
import { HttpError } from '../lib/httpError';
import { cancelOrderReservation, createPendingOrder, validateCreatePendingOrderInput } from '../services/checkout';
import { createStripeCheckoutSession } from '../services/stripeCheckout';
import { prisma } from '../lib/prisma';
import { requireReferralOrAuth } from '../middleware/referralAccess';

const router = Router();

// 在庫仮引当・Stripeセッション作成の自動連打による在庫ロック濫用を防ぐ(仕様書外の拡張)。
const createSessionLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

router.post('/checkout/create-session', createSessionLimiter, requireReferralOrAuth, async (req, res) => {
  let orderId: string | null = null;
  try {
    const input = validateCreatePendingOrderInput(req.body);
    const { order, items } = await createPendingOrder(input);
    orderId = order.id;

    const session = await createStripeCheckoutSession(order, items);

    await prisma.order.update({
      where: { id: order.id },
      data: { stripeSessionId: session.id },
    });

    res.status(201).json({
      orderId: order.id,
      orderNumber: order.orderNumber,
      totalAmount: order.totalAmount,
      stripeCheckoutUrl: session.url,
    });
  } catch (e) {
    if (e instanceof HttpError) {
      if (orderId && e.code === 'STRIPE_NOT_CONFIGURED') {
        await cancelOrderReservation(orderId);
      }
      return sendError(res, e.status, e.code, e.message);
    }
    if (orderId) {
      await cancelOrderReservation(orderId).catch(() => {});
    }
    console.error(e);
    sendError(res, 500, 'STRIPE_SESSION_FAILED', 'Stripe決済セッションの作成に失敗しました');
  }
});

// successページでの決済状況ポーリング用(仕様書v1.5 4.6)。
// successページ到達自体を決済完了とみなさず、Webhookで確定したorderの状態のみを返す。
router.get('/checkout/session/:sessionId/status', async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { stripeSessionId: req.params.sessionId },
    select: { orderNumber: true, paymentStatus: true },
  });

  if (!order) {
    return sendError(res, 404, 'ORDER_NOT_FOUND', '注文が見つかりません');
  }

  res.json({ orderNumber: order.orderNumber, paymentStatus: order.paymentStatus });
});

export default router;
