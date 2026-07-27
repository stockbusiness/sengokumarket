import { Router } from 'express';
import { dbRateLimit } from '../middleware/dbRateLimit';
import { sendError } from '../lib/apiError';
import { HttpError } from '../lib/httpError';
import { cancelOrderReservation, createPendingOrder, validateCreatePendingOrderInput } from '../services/checkout';
import { createStripeCheckoutSession } from '../services/stripeCheckout';
import { BANK_TRANSFER_EXPIRY_DAYS, getBankTransferConfig, isBankTransferAvailable } from '../services/bankTransfer';
import { prisma } from '../lib/prisma';
import { enqueueNotification } from '../modules/notifications/infrastructure/notificationOutbox.repository';
import { triggerImmediateNotificationDispatch } from '../modules/notifications/application/dispatchNotificationOutbox.usecase';
import { requireReferralOrAuth } from '../middleware/referralAccess';
import { AUTH_COOKIE_NAME } from '../lib/authCookie';
import { verifyAuthToken } from '../services/jwt';
import { resolveReferral } from '../services/referral';
import { validateCoupon } from '../services/coupon';
import { hashRateLimitIdentifier } from '../services/rateLimiter';

const router = Router();

// 残課題指示書Stage12/本番安定化指示書Stage3: 複数Vercelインスタンス間で回数が共有される
// DB永続化型のレート制限に差し替える。IP単独・識別子単独・複合の3bucketを独立して検査する
// (6.2)。在庫仮引当・Stripeセッション作成の自動連打による在庫ロック濫用を防ぐ
// (仕様書外の拡張)。customerEmailがあればIPに加えて識別子として使う。IP単独bucketは
// 複数の購入者が同じ店舗Wi-Fi等を共有する場合を考慮し、メールアドレス単独より緩めにする。
const createSessionLimiter = dbRateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 20,
  ipLimit: 50,
  scope: 'checkout-create-session',
  identify: (req) => (typeof req.body?.customerEmail === 'string' ? hashRateLimitIdentifier(req.body.customerEmail) : undefined),
});
// クーポンコード総当たり対策(仕様書16.2)。特定のクーポンコードへ大量に試行が集中するのを
// 防ぐため、コード自体も識別子に加える。IP単独bucketは、同じ店舗Wi-Fi等から複数の購入者が
// それぞれ別のクーポンコードを試すプレビュー操作を過剰にブロックしないよう、コード単独より
// 緩めにする(他の3つのlimiterと同じ方針)。
const couponValidateLimiter = dbRateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  ipLimit: 30,
  scope: 'coupon-validate',
  identify: (req) => (typeof req.body?.couponCode === 'string' ? hashRateLimitIdentifier(req.body.couponCode) : undefined),
});

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

// チェックアウト画面が決済手段の選択肢を出し分けるための公開設定(仕様書外の拡張)。
router.get('/checkout/config', async (_req, res) => {
  const config = await getBankTransferConfig();
  const bankTransferAvailable = config.enabled && config.info.trim().length > 0;
  res.json({
    bankTransferAvailable,
    bankTransferInfo: bankTransferAvailable ? config.info : null,
    bankTransferExpiryDays: BANK_TRANSFER_EXPIRY_DAYS,
  });
});

router.post('/checkout/create-session', createSessionLimiter, requireReferralOrAuth, async (req, res) => {
  let orderId: string | null = null;
  try {
    const input = validateCreatePendingOrderInput(req.body);

    if (input.paymentMethod === 'bank_transfer' && !(await isBankTransferAvailable())) {
      return sendError(res, 400, 'BANK_TRANSFER_NOT_AVAILABLE', '銀行振込は現在ご利用いただけません');
    }

    const { order, items } = await createPendingOrder(input);
    orderId = order.id;

    // 本番安定化指示書Stage1: common_user_id解決・referral captureのジョブは注文作成と
    // 同一トランザクションで既に永続化済み(createPendingOrder内)。以前はここでベストエフォートの
    // 即時ディスパッチを試みていたが、外部APIの遅延がCheckoutレスポンスをそのまま遅延させて
    // しまうため廃止した。処理はCron(またはFeature Flag有効時の管理者による明示的な再送)に委ねる。

    if (input.paymentMethod === 'bank_transfer') {
      const config = await getBankTransferConfig();
      // Wallet Claim本番前安定化指示書(2026-07-25)Phase11(13.2): 通知予定作成だけを行い実送信を
      // 待たない対象として明示されているのはStripe Webhookと銀行振込入金確認(管理者の入金確認
      // 操作)の2箇所のみで、ここ(顧客自身によるCheckout申込リクエスト)は含まれない。従来から
      // このリクエスト内でメール送信まで完了させていた挙動を維持するため、Outboxへ通知予定を
      // 作成した上で即時ディスパッチも行う(Resend呼び出し失敗時も注文自体は成立済みで、
      // 取りこぼしは5分Cronが拾う)。
      await enqueueNotification(prisma, {
        eventType: 'bank_transfer_instructions',
        recipient: order.customerEmail,
        payload: { orderId: order.id },
      });
      await triggerImmediateNotificationDispatch();

      return res.status(201).json({
        orderId: order.id,
        orderNumber: order.orderNumber,
        totalAmount: order.totalAmount,
        stripeCheckoutUrl: null,
        paymentMethod: 'bank_transfer',
        bankTransferInfo: config.info,
        bankTransferExpiryDays: BANK_TRANSFER_EXPIRY_DAYS,
      });
    }

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
      paymentMethod: 'stripe',
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

// 仕様書外の拡張(クーポン機能): 購入前のプレビュー用。実際の予約は行わず、検証と割引額計算のみ行う。
// 最終的な正としての検証はcreate-session側(reserveCouponUsage)で改めて行う。
router.post('/checkout/coupons/validate', requireReferralOrAuth, couponValidateLimiter, async (req, res) => {
  const { couponCode, referralCode, items: rawItems } = req.body ?? {};

  if (!isNonEmptyString(couponCode)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'クーポンコードを入力してください');
  }
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return res.json({ valid: false, message: 'カートが空です' });
  }

  const items = rawItems as unknown[];
  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    if (!isNonEmptyString(item?.variantId) || !Number.isInteger(item.quantity) || (item.quantity as number) < 1) {
      return res.json({ valid: false, message: 'カートの内容が不正です' });
    }
  }

  const token = req.cookies?.[AUTH_COOKIE_NAME];
  const authPayload = typeof token === 'string' ? verifyAuthToken(token) : null;
  const userId = authPayload?.sub ?? null;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const variantIds = items.map((raw) => (raw as Record<string, unknown>).variantId as string);
      const variants = await tx.productVariant.findMany({ where: { id: { in: variantIds } } });
      const variantById = new Map(variants.map((v) => [v.id, v]));

      const eligibilityItems = items.map((raw) => {
        const item = raw as Record<string, unknown>;
        const variant = variantById.get(item.variantId as string);
        if (!variant) throw new HttpError(404, 'PRODUCT_NOT_FOUND', '商品が見つかりません');
        return { productId: variant.productId, subtotal: variant.price * (item.quantity as number) };
      });

      const referral = await resolveReferral(tx, isNonEmptyString(referralCode) ? referralCode : null);

      return validateCoupon(tx, {
        code: couponCode.trim().toUpperCase(),
        userId,
        agencyId: referral.agencyId,
        items: eligibilityItems,
      });
    });

    res.json({
      valid: true,
      coupon: {
        name: result.coupon.name,
        code: result.coupon.code,
        discountType: result.coupon.discountType,
      },
      pricing: {
        originalAmount: result.originalAmount,
        discountAmount: result.discountAmount,
        finalAmount: result.finalAmount,
      },
    });
  } catch (e) {
    if (e instanceof HttpError) {
      return res.json({ valid: false, message: e.message });
    }
    throw e;
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
