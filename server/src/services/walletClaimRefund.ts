import type { Order, Prisma } from '@prisma/client';
import { getDigitalCollectibleRule } from './digitalCollectible';
import { enqueueDigitalCollectibleEvent } from './integrationOutbox';

type Tx = Prisma.TransactionClient;

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)16章「返金」: WalletClaim・
// CollectibleDeliveryの進行段階に応じて異なる取消処理を行う。全額返金のトランザクション内
// (stripeWebhookHandlers.tsのhandleChargeRefunded)からのみ呼ばれる。この注文にWalletClaimが
// 存在しない(digital_collectible対象外、またはENABLE_WALLET_CLAIM無効時)は何もしない。
export async function applyWalletClaimRefundEffects(tx: Tx, order: Order): Promise<void> {
  const claim = await tx.walletClaim.findUnique({ where: { orderId: order.id } });
  if (!claim) return;

  // 既に無効化・期限切れの場合は何もしない(二重処理防止)。
  if (claim.status === 'REVOKED' || claim.status === 'EXPIRED') return;

  if (claim.status === 'PENDING' || claim.status === 'ERROR') {
    // Claim前: NftIssue=cancelledは既存のhandleChargeRefunded内の処理(wallet_required/
    // ready_to_issue → cancelled)で対応済みのため、ここではWalletClaimのみ無効化する。
    await tx.walletClaim.update({ where: { id: claim.id }, data: { status: 'REVOKED' } });
    return;
  }

  if (claim.status === 'CLAIMED' || claim.status === 'DELIVERY_PENDING') {
    // Claim後・送付前: 未送付(DELIVEREDでない)CollectibleDeliveryをREVOKEDにし、
    // 未送信(pending/blocked)のgrantedイベントは送信禁止(blocked)にする。
    const deliveries = await tx.collectibleDelivery.findMany({
      where: { walletClaimId: claim.id, status: { not: 'DELIVERED' } },
    });
    for (const delivery of deliveries) {
      if (delivery.status === 'PROCESSING') {
        // 外部Mint API連携のprocessing行と同じ方針: 送信中の可能性がある行は状態を強制変更せず、
        // 注記のみ残して手動確認に委ねる(処理中の外部呼び出しと競合させないため)。
        const note = '返金発生・送付処理中のため要手動確認';
        await tx.collectibleDelivery.update({
          where: { id: delivery.id },
          data: { lastError: delivery.lastError ? `${delivery.lastError}\n${note}` : note },
        });
        continue;
      }
      if (delivery.outboxEventId) {
        await tx.integrationOutboxEvent.updateMany({
          where: { id: delivery.outboxEventId, status: { in: ['pending', 'blocked'] } },
          data: { status: 'blocked', blockedReason: 'wallet_claim_revoked' },
        });
      }
      await tx.collectibleDelivery.update({ where: { id: delivery.id }, data: { status: 'REVOKED', revokedAt: new Date() } });
    }
    await tx.walletClaim.update({ where: { id: claim.id }, data: { status: 'REVOKED' } });
    return;
  }

  if (claim.status === 'DELIVERED') {
    // 送付後: NftIssue単位でMint済み(issued)かどうかで扱いを分ける。
    const deliveries = await tx.collectibleDelivery.findMany({ where: { walletClaimId: claim.id, status: 'DELIVERED' } });
    for (const delivery of deliveries) {
      const nftIssue = await tx.nftIssue.findUnique({ where: { id: delivery.nftIssueId } });
      if (!nftIssue) continue;

      if (nftIssue.status === 'issued') {
        // Mint後: 自動処理せずmanual_review_requiredの注記のみ(16章)。
        const note = 'manual_review_required: Mint後に返金発生・要手動確認(digital_collectible)';
        await tx.nftIssue.update({
          where: { id: nftIssue.id },
          data: { adminNote: nftIssue.adminNote ? `${nftIssue.adminNote}\n${note}` : note },
        });
        continue;
      }

      // 送付後・Mint前: NftIssue単位でentitlement.revokedを送信する。送信成功後の
      // CollectibleDelivery=REVOKED反映はsyncCollectibleDeliveryOnSend(dispatcher側)が行う。
      const orderItem = await tx.orderItem.findUnique({ where: { id: nftIssue.orderItemId } });
      if (!orderItem) continue;
      const rule = await getDigitalCollectibleRule(tx, nftIssue.productId);
      if (!rule) continue;
      const product = await tx.product.findUnique({ where: { id: nftIssue.productId } });
      if (!product) continue;

      await enqueueDigitalCollectibleEvent(tx, {
        order,
        orderItem,
        nftIssue,
        rule,
        product,
        commonUserId: delivery.commonUserId,
        eventType: 'entitlement.revoked',
      });
    }
  }
}
