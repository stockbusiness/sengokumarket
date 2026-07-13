import type Stripe from 'stripe';
import { prisma } from '../lib/prisma';
import { findOrderForEvent } from './orderLookup';
import { applyPaidOrderSideEffects, sendPostPaymentEmails } from './orderFulfillment';
import { sendCartAbandonedEmail } from './mailTemplates';
import { cancelCouponUsage, restoreCouponUsageOnFullRefund } from './coupon';
import { triggerImmediateNftMintProcessing } from './nftMintProcessing';

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

  // stripe_events登録済みのため、ここで例外を投げるとWebhookが二重処理されずリトライされなくなってしまう
  // (sendPostPaymentEmails内部で例外は握りつぶし済み)。
  await sendPostPaymentEmails(result.order, result.items);

  // 仕様書外の拡張(NFT自動発行): cronの実行間隔(Vercelプランによっては日次)を待たせないよう、
  // 決済確定直後にベストエフォートで発行処理を試みる(失敗時はcronがセーフティネットとして拾う)。
  await triggerImmediateNftMintProcessing();
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

    return { order: updatedOrder, items: orderItems };
  });

  if (!result) return;

  // カート放棄リマインドメール。決済処理自体には影響させないためトランザクション外・例外握りつぶし(仕様書v1.5 7.6と同様の方針)。
  try {
    await sendCartAbandonedEmail(result.order, result.items, result.items[0]?.product.slug ?? null);
  } catch (e) {
    console.error('cart-abandoned email dispatch failed', { orderId: result.order.id, error: e });
  }
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
}
