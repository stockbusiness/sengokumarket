import type Stripe from 'stripe';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { findOrderForEvent } from './orderLookup';
import { createPasswordResetToken } from './passwordReset';
import { sendCartAbandonedEmail, sendGuestPasswordSetupEmail, sendPurchaseCompleteEmail } from './mailTemplates';

type Tx = Prisma.TransactionClient;

function eventTime(event: Stripe.Event): Date {
  return new Date(event.created * 1000);
}

// order_items.item_type = 'nft' の行のみ、quantity個ぶん個別レコードを作成する(仕様書v1.5 6.7 / 7.2)
async function createNftIssuesForOrder(tx: Tx, orderId: string, userId: string | null) {
  const orderItems = await tx.orderItem.findMany({ where: { orderId, itemType: 'nft' } });
  if (orderItems.length === 0) return;

  const wallet = userId ? await tx.wallet.findUnique({ where: { userId } }) : null;

  for (const item of orderItems) {
    const rows = Array.from({ length: item.quantity }, () => ({
      orderId,
      orderItemId: item.id,
      userId,
      productId: item.productId,
      variantId: item.variantId,
      status: wallet ? 'ready_to_issue' : 'wallet_required',
      walletAddress: wallet ? wallet.walletAddress : null,
    }));
    await tx.nftIssue.createMany({ data: rows });
  }
}

// referral_link_idがある注文のみcommissionsを作成する。0円はstatus=cancelledで作成(追跡用)。仕様書v1.5 6.14
async function createCommissionForOrder(tx: Tx, order: NonNullable<Awaited<ReturnType<typeof findOrderForEvent>>>) {
  if (!order.referralLinkId) return;

  const commissionRate = Number(order.commissionRate);
  const commissionAmount = Math.round((order.totalAmount * commissionRate) / 100);
  const status = commissionRate > 0 ? 'pending' : 'cancelled';

  await tx.commission.create({
    data: {
      orderId: order.id,
      agencyId: order.agencyId,
      influencerId: order.influencerId,
      referralCode: order.referralCode,
      baseAmount: order.totalAmount,
      commissionRate,
      commissionAmount,
      status,
    },
  });

  await tx.order.update({
    where: { id: order.id },
    data: { commissionAmount, commissionStatus: status },
  });
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

    const orderItems = await tx.orderItem.findMany({ where: { orderId: order.id } });
    for (const item of orderItems) {
      if (!item.variantId) continue;
      await tx.productVariant.update({
        where: { id: item.variantId },
        data: { stock: { decrement: item.quantity }, reservedStock: { decrement: item.quantity } },
      });
    }

    await createNftIssuesForOrder(tx, order.id, order.userId);
    await createCommissionForOrder(tx, updatedOrder);

    return { order: updatedOrder, items: orderItems };
  });

  if (!result) return;

  // メール送信(トークン発行含む)はトランザクション外で行い、失敗しても決済処理自体は
  // 失敗させない(仕様書v1.5 7.2 手順8 / 7.6)。stripe_events登録済みのため、ここで
  // 例外を投げるとWebhookが二重処理されずリトライされなくなってしまう。
  try {
    await sendPurchaseCompleteEmail(result.order, result.items);

    if (result.order.guestAccountCreated && result.order.userId) {
      const token = await createPasswordResetToken(result.order.userId);
      await sendGuestPasswordSetupEmail(result.order.customerEmail, result.order.customerName, token);
    }
  } catch (e) {
    console.error('post-payment email dispatch failed', { orderId: result.order.id, error: e });
  }
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
