import type Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { findOrderForEvent } from './orderLookup';
import { applyPaidOrderSideEffects } from './orderFulfillment';
import { cancelCouponUsage, restoreCouponUsageOnFullRefund } from './coupon';
import { enqueueEntitlementEvents } from './integrationOutbox';
import { applyWalletClaimRefundEffects } from './walletClaimRefund';
import { enqueueProvisioningRevokeJobIfApplicable } from './purchaseProvisioningJobs';
import { enqueueNotification } from '../modules/notifications/infrastructure/notificationOutbox.repository';

function eventTime(event: Stripe.Event): Date {
  return new Date(event.created * 1000);
}

export async function handleCheckoutSessionCompleted(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;

  const result = await prisma.$transaction(async (tx) => {
    const order = await findOrderForEvent(tx, {
      orderId: session.metadata?.order_id,
      paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
      sessionId: session.id,
    });

    if (!order) {
      console.error('checkout.session.completed: order not found', { sessionId: session.id });
      return null;
    }

    // 冪等性: stripe_eventsの重複INSERT防止に加え、既にpaid済みなら二重処理しない
    if (order.paymentStatus === 'paid') return null;

    const updatedOrder = await tx.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: 'paid',
        orderStatus: 'paid',
        paidAt: eventTime(event),
        stripeSessionId: session.id,
        stripePaymentIntentId:
          typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id ?? null),
      },
    });

    return applyPaidOrderSideEffects(tx, updatedOrder);
  });

  if (!result) return;

  // Wallet Claim本番前安定化指示書(2026-07-25)Phase11(13.2「Stripe WebhookがResendを待たない」):
  // 購入完了・ゲストパスワード設定メールの通知予定(Outbox)は上記トランザクション内
  // (applyPaidOrderSideEffects)で既に永続化済み。本番安定化指示書Stage1と同じ方針(NFT発行・
  // order_linking_jobs・integration_outbox_events)で、ここではベストエフォートの即時
  // ディスパッチも行わない(実送信=Resend呼び出しがStripe Webhookの応答自体を遅延させ、
  // Stripe側のリトライ・タイムアウトを誘発しうるため)。実送信は5分Cron
  // (process-notification-outbox)に委ねる。
}

export async function handleCheckoutSessionExpired(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;

  const result = await prisma.$transaction(async (tx) => {
    const order = await findOrderForEvent(tx, {
      orderId: session.metadata?.order_id,
      paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
      sessionId: session.id,
    });

    if (!order) {
      console.error('checkout.session.expired: order not found', { sessionId: session.id });
      return null;
    }

    if (order.paymentStatus !== 'pending') return null;

    const updatedOrder = await tx.order.update({
      where: { id: order.id },
      data: { paymentStatus: 'expired', expiredAt: eventTime(event) },
    });

    const orderItems = await tx.orderItem.findMany({ where: { orderId: order.id }, include: { product: true } });
    for (const item of orderItems) {
      if (!item.variantId) continue;
      await tx.productVariant.update({
        where: { id: item.variantId },
        data: { reservedStock: { decrement: item.quantity } },
      });
    }

    await cancelCouponUsage(tx, order.id, 'expired');

    // Wallet Claim本番前安定化指示書(2026-07-25)Phase11: カート放棄リマインドメールは注文の
    // 失効と同一トランザクションで通知予定(Outbox)だけを作成する。Resend完了は待たない。
    await enqueueNotification(tx, {
      eventType: 'cart_abandoned',
      recipient: updatedOrder.customerEmail,
      payload: { orderId: updatedOrder.id },
    });

    return { order: updatedOrder, items: orderItems };
  });

  if (!result) return;

  // Phase11(13.2「Stripe WebhookがResendを待たない」): 上記と同じ理由でベストエフォート即時
  // ディスパッチも行わない。実送信は5分Cronに委ねる。
}

export async function handlePaymentIntentFailed(event: Stripe.Event) {
  const paymentIntent = event.data.object as Stripe.PaymentIntent;

  await prisma.$transaction(async (tx) => {
    const order = await findOrderForEvent(tx, {
      orderId: paymentIntent.metadata?.order_id,
      paymentIntentId: paymentIntent.id,
    });

    if (!order) {
      console.error('payment_intent.payment_failed: order not found', { paymentIntentId: paymentIntent.id });
      return;
    }

    if (order.paymentStatus !== 'pending') return;

    // 仮引当はSessionが生きている間は維持する(最終的な解放はexpiredで行う。仕様書v1.5 7.3)
    await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'failed' } });
  });
}

export async function handleChargeRefunded(event: Stripe.Event) {
  const charge = event.data.object as Stripe.Charge;
  const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;

  await prisma.$transaction(async (tx) => {
    const order = await findOrderForEvent(tx, { paymentIntentId });

    if (!order) {
      console.error('charge.refunded: order not found', { paymentIntentId });
      return;
    }

    const isFullRefund = charge.amount_refunded >= charge.amount;

    if (!isFullRefund) {
      const note = `一部返金検知(${charge.amount_refunded}円)・要手動確認`;
      await tx.order.update({
        where: { id: order.id },
        data: { adminNote: order.adminNote ? `${order.adminNote}\n${note}` : note },
      });
      return;
    }

    if (order.paymentStatus === 'refunded') return;

    await tx.order.update({
      where: { id: order.id },
      data: { paymentStatus: 'refunded', orderStatus: 'refunded', refundedAt: eventTime(event) },
    });

    await tx.nftIssue.updateMany({
      where: { orderId: order.id, status: { in: ['wallet_required', 'ready_to_issue'] } },
      data: { status: 'cancelled' },
    });

    // 仕様書外の拡張(NFT自動発行): 外部Mint APIへ送信済み・確定待ち(processing)の行は
    // 送信中のリクエストと競合しうるためここでは触らない(cancelledにしない)。
    // Mintが完了してしまっても管理者が事後確認できるよう、注記だけ残す。
    const processingIssues = await tx.nftIssue.findMany({ where: { orderId: order.id, status: 'processing' } });
    for (const issue of processingIssues) {
      const note = '全額返金発生・発行処理中のため要手動確認';
      await tx.nftIssue.update({
        where: { id: issue.id },
        data: { adminNote: issue.adminNote ? `${issue.adminNote}\n${note}` : note },
      });
    }

    // 仕様書外の拡張(クーポン機能): 全額返金時、クーポン設定のrestoreOnCancelに従って
    // 再利用可能へ戻す(一部返金では呼ばない。仕様書12章)。
    await restoreCouponUsageOnFullRefund(tx, order.id);

    // 仕様書外の拡張(千ノ国全体統合契約2026-07-21 6章): 全額返金と同一トランザクションで
    // entitlement.revokedをOutboxへ記録する(送信先ルール未設定の商品はno-op)。
    const refundedOrder = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
    const orderItems = await tx.orderItem.findMany({ where: { orderId: order.id } });
    await enqueueEntitlementEvents(tx, refundedOrder, orderItems, 'entitlement.revoked');

    // 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)16章: WalletClaim/
    // CollectibleDeliveryの進行段階に応じた取消処理(この注文にWalletClaimがなければno-op)。
    await applyWalletClaimRefundEffects(tx, refundedOrder);

    // 購入後代理店システム連携実装指示書 10章: 全額返金と同一トランザクションでrevokeジョブを
    // 記録する(provisioningジョブを一度も作っていない注文はno-op。実送信はcommit後に
    // Dispatcherがcron経由で行う)。
    await enqueueProvisioningRevokeJobIfApplicable(tx, refundedOrder);

    const commission = await tx.commission.findUnique({ where: { orderId: order.id } });
    if (commission) {
      if (commission.status === 'pending' || commission.status === 'approved') {
        await tx.commission.update({ where: { id: commission.id }, data: { status: 'cancelled' } });
        await tx.order.update({ where: { id: order.id }, data: { commissionStatus: 'cancelled' } });
      } else if (commission.status === 'paid') {
        const note = '返金発生・報酬要回収';
        await tx.commission.update({
          where: { id: commission.id },
          data: { adminNote: commission.adminNote ? `${commission.adminNote}\n${note}` : note },
        });
      }
    }
  });

  // 本番安定化指示書Stage1: entitlement.revokedは上記トランザクション内で既に永続化済み。
  // 以前はここでベストエフォートの即時ディスパッチを試みていたが、Stripe Webhookの応答を
  // 外部APIの遅延に晒すことになるため廃止した。処理はCron(またはFeature Flag有効時の
  // 管理者による明示的な再送)に委ねる。
}
