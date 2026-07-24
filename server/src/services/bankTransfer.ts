import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/httpError';
import { getSetting, setSetting } from './settings';
import { applyPaidOrderSideEffects, sendPostPaymentEmails } from './orderFulfillment';
import { cancelCouponUsage } from './coupon';

// 仕様書外の拡張: 銀行振込(手動確認型)決済。
// Stripeとは異なり決済の即時確認手段がないため、注文は「振込待ち」のpending状態で作成し、
// 管理者が入金を確認したら手動でconfirmBankTransferPaymentを呼んで決済確定させる。
// 在庫の仮引当はcreatePendingOrderと共通(checkout.ts側で決済手段によらず同じ関数を使う)。

// 振込待ちのまま長期間放置された注文は、この日数を過ぎたらcronで自動的に失効させ在庫を解放する。
export const BANK_TRANSFER_EXPIRY_DAYS = 7;

export interface BankTransferConfig {
  enabled: boolean;
  info: string;
}

export async function getBankTransferConfig(): Promise<BankTransferConfig> {
  const [enabledRaw, info] = await Promise.all([getSetting('bank_transfer_enabled'), getSetting('bank_transfer_info')]);
  return { enabled: enabledRaw === 'true', info: info ?? '' };
}

export async function setBankTransferConfig(config: BankTransferConfig): Promise<void> {
  await Promise.all([setSetting('bank_transfer_enabled', config.enabled ? 'true' : 'false'), setSetting('bank_transfer_info', config.info)]);
}

// 銀行振込での注文受付が可能か(管理画面で有効化済み、かつ案内文が設定済み)。
export async function isBankTransferAvailable(): Promise<boolean> {
  const config = await getBankTransferConfig();
  return config.enabled && config.info.trim().length > 0;
}

// 管理者が入金確認ボタンを押した時に呼ぶ。Stripe WebhookのhandleCheckoutSessionCompletedと
// 同じ決済確定処理(在庫確定・NFT発行キュー作成・報酬計算・購入完了メール)を行う。
export async function confirmBankTransferPayment(orderId: string) {
  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', '注文が見つかりません');
    if (order.paymentMethod !== 'bank_transfer') {
      throw new HttpError(400, 'NOT_BANK_TRANSFER_ORDER', '銀行振込の注文ではありません');
    }
    if (order.paymentStatus === 'paid') {
      throw new HttpError(400, 'ALREADY_PAID', '既に入金確認済みです');
    }
    if (order.paymentStatus !== 'pending') {
      throw new HttpError(400, 'INVALID_ORDER_STATUS', `この注文は現在「${order.paymentStatus}」のため入金確認できません`);
    }

    const updatedOrder = await tx.order.update({
      where: { id: order.id },
      data: { paymentStatus: 'paid', orderStatus: 'paid', paidAt: new Date() },
    });

    return applyPaidOrderSideEffects(tx, updatedOrder);
  });

  await sendPostPaymentEmails(result.order, result.items);
  // 本番安定化指示書Stage1: NFT発行・order_linking_jobs・integration_outbox_eventsは
  // 上記トランザクション内(applyPaidOrderSideEffects)で既に永続化済み。以前はここで
  // ベストエフォートの即時ディスパッチを試みていたが、管理者の入金確認操作(この関数の
  // 呼び出し元)が外部API待ちで遅延してしまうため廃止した。処理はCron(またはFeature Flag
  // 有効時の管理者による明示的な再送)に委ねる。
  return result;
}

// cronから日次で呼び出し、振込期限(BANK_TRANSFER_EXPIRY_DAYS)を過ぎた未入金の銀行振込注文を失効させ、
// 仮引当していた在庫を解放する(Stripeのcheckout.session.expired相当)。
export async function expireOverdueBankTransferOrders(): Promise<{ expiredCount: number }> {
  const cutoff = new Date(Date.now() - BANK_TRANSFER_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const overdueOrders = await prisma.order.findMany({
    where: { paymentMethod: 'bank_transfer', paymentStatus: 'pending', createdAt: { lt: cutoff } },
    select: { id: true },
  });

  let expiredCount = 0;
  for (const { id } of overdueOrders) {
    await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id } });
      if (!order || order.paymentStatus !== 'pending') return;

      await tx.order.update({ where: { id }, data: { paymentStatus: 'expired', expiredAt: new Date() } });

      const items = await tx.orderItem.findMany({ where: { orderId: id } });
      for (const item of items) {
        if (!item.variantId) continue;
        await tx.productVariant.update({
          where: { id: item.variantId },
          data: { reservedStock: { decrement: item.quantity } },
        });
      }

      await cancelCouponUsage(tx, id, 'expired');
    });
    expiredCount += 1;
  }

  return { expiredCount };
}
