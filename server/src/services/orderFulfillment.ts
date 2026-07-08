import type { Order, OrderItem, Prisma } from '@prisma/client';
import { createPasswordResetToken } from './passwordReset';
import { sendGuestPasswordSetupEmail, sendPurchaseCompleteEmail } from './mailTemplates';

type Tx = Prisma.TransactionClient;

// 決済確定時の共通処理(Stripe Webhook・銀行振込の手動確認の両方から呼ばれる)。
// 呼び出し元は、決済手段固有のカラム(stripeSessionId等)を含めて先にorders.paymentStatus='paid'への
// 更新を済ませたうえで、その更新後のorderを渡すこと。

// order_items.item_type = 'nft' の行のみ、quantity個ぶん個別レコードを作成する(仕様書v1.5 6.7 / 7.2)
export async function createNftIssuesForOrder(tx: Tx, orderId: string, userId: string | null) {
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
export async function createCommissionForOrder(tx: Tx, order: Order) {
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

// paymentStatus='paid'への更新後に呼ぶ: 在庫確定・NFT発行キュー作成・報酬計算をまとめて行う。
export async function applyPaidOrderSideEffects(tx: Tx, order: Order) {
  const orderItems = await tx.orderItem.findMany({ where: { orderId: order.id } });
  for (const item of orderItems) {
    if (!item.variantId) continue;
    await tx.productVariant.update({
      where: { id: item.variantId },
      data: { stock: { decrement: item.quantity }, reservedStock: { decrement: item.quantity } },
    });
  }

  await createNftIssuesForOrder(tx, order.id, order.userId);
  await createCommissionForOrder(tx, order);

  return { order, items: orderItems };
}

// メール送信はトランザクション外で行い、失敗しても決済確定処理自体は失敗させない(仕様書v1.5 7.2 手順8 / 7.6)。
export async function sendPostPaymentEmails(order: Order, items: OrderItem[]) {
  try {
    await sendPurchaseCompleteEmail(order, items);

    if (order.guestAccountCreated && order.userId) {
      const token = await createPasswordResetToken(order.userId);
      await sendGuestPasswordSetupEmail(order.customerEmail, order.customerName, token);
    }
  } catch (e) {
    console.error('post-payment email dispatch failed', { orderId: order.id, error: e });
  }
}
