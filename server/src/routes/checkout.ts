import { Router } from 'express';
import { sendError } from '../lib/apiError';
import { HttpError } from '../lib/httpError';
import { createPendingOrder, validateCreatePendingOrderInput } from '../services/checkout';

const router = Router();

router.post('/checkout/create-session', async (req, res) => {
  try {
    const input = validateCreatePendingOrderInput(req.body);
    const result = await createPendingOrder(input);

    // Stripe Checkout Session作成はStep 6で実装する(仕様書v1.5 7.1参照)。
    res.status(201).json({
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      totalAmount: result.totalAmount,
      stripeCheckoutUrl: null,
    });
  } catch (e) {
    if (e instanceof HttpError) {
      return sendError(res, e.status, e.code, e.message);
    }
    console.error(e);
    sendError(res, 500, 'INTERNAL_ERROR', '注文の作成に失敗しました');
  }
});

export default router;
