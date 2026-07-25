import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { hashClaimToken } from './walletClaim';
import { getDigitalCollectibleRule } from './digitalCollectible';
import { enqueueDigitalCollectibleEvent } from './integrationOutbox';
import { triggerImmediateOutboxDispatch } from './integrationOutboxDispatcher';

type Tx = Prisma.TransactionClient;

export interface WalletClaimStatusResult {
  status: string;
  expiresAt: Date;
}

// GET /api/integrations/wallet-claims/{token}: 千ノ国ウォレット側がConfirm前に状態を確認するための
// 読み取り専用API。注文の個人情報(氏名・メール等)は一切含めない。
export async function getWalletClaimStatus(token: string): Promise<WalletClaimStatusResult | null> {
  const tokenHash = hashClaimToken(token);
  const claim = await prisma.walletClaim.findUnique({ where: { tokenHash } });
  if (!claim) return null;

  if (claim.status === 'PENDING' && claim.expiresAt < new Date()) {
    await prisma.walletClaim.updateMany({ where: { id: claim.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
    return { status: 'EXPIRED', expiresAt: claim.expiresAt };
  }

  return { status: claim.status, expiresAt: claim.expiresAt };
}

export type ConfirmWalletClaimOutcome =
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'revoked' }
  | { kind: 'order_not_paid' }
  | { kind: 'order_refunded' }
  | { kind: 'common_user_unresolved' }
  | { kind: 'common_user_mismatch' }
  | { kind: 'conflict' } // 同時実行中(既にCLAIMEDでロック済み)
  | { kind: 'ok'; status: string };

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)10章のトランザクション手順に対応する。
// 冪等性: 既にDELIVERY_PENDING/DELIVEREDの場合、同一common_user_idでの再確認はokを返し
// (Delivery・Outboxの重複作成はしない)、異なるcommon_user_idでの再確認はmismatchとして扱う。
export async function confirmWalletClaim(
  token: string,
  input: { oveAccountId: string; commonUserId: string },
): Promise<ConfirmWalletClaimOutcome> {
  const tokenHash = hashClaimToken(token);

  return prisma.$transaction(async (tx): Promise<ConfirmWalletClaimOutcome> => {
    const claim = await tx.walletClaim.findUnique({ where: { tokenHash } });
    if (!claim) return { kind: 'not_found' };

    if (claim.status === 'REVOKED') return { kind: 'revoked' };

    if (claim.status === 'EXPIRED' || (claim.status === 'PENDING' && claim.expiresAt < new Date())) {
      await tx.walletClaim.updateMany({ where: { id: claim.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
      return { kind: 'expired' };
    }

    if (claim.status === 'DELIVERY_PENDING' || claim.status === 'DELIVERED') {
      // 既に確定済み。異なるcommon_user_idでの再確認は他人による乗っ取り試行の可能性があるため
      // 拒否・監査ログ記録する(9章「禁止: Claim Tokenだけで別common_user_idへ送付」)。
      if (claim.commonUserId && claim.commonUserId !== input.commonUserId) {
        await tx.walletClaimAuditLog.create({
          data: {
            walletClaimId: claim.id,
            orderId: claim.orderId,
            eventType: 'common_user_mismatch',
            detail: { requestedCommonUserId: input.commonUserId, claimCommonUserId: claim.commonUserId, phase: 're-confirm' },
          },
        });
        return { kind: 'common_user_mismatch' };
      }
      return { kind: 'ok', status: claim.status };
    }

    // ここに到達するのはstatus IN ('PENDING','ERROR')のみ。原子的にCLAIMEDへ遷移させ、
    // 同時に届いた別リクエストが同じ処理を二重に行わないようにする(10章「同時実行でも
    // Delivery・Outboxを重複作成しない」)。
    const claimed = await tx.$executeRaw`
      UPDATE wallet_claims SET status = 'CLAIMED', updated_at = now()
      WHERE id = ${claim.id}::uuid AND status IN ('PENDING', 'ERROR')
    `;
    if (claimed === 0) return { kind: 'conflict' };

    const order = await tx.order.findUnique({ where: { id: claim.orderId } });
    if (!order) {
      await tx.walletClaim.update({ where: { id: claim.id }, data: { status: 'ERROR', lastError: 'order not found' } });
      return { kind: 'not_found' };
    }

    if (order.orderStatus === 'refunded' || order.paymentStatus === 'refunded') {
      await tx.walletClaim.update({ where: { id: claim.id }, data: { status: 'REVOKED', lastError: 'order refunded' } });
      return { kind: 'order_refunded' };
    }

    if (order.paymentStatus !== 'paid') {
      // 決済未確定は一時的な状態の可能性があるため、再試行できるようERRORへ留める(REVOKEDにはしない)。
      await tx.walletClaim.update({ where: { id: claim.id }, data: { status: 'ERROR', lastError: 'order not paid' } });
      return { kind: 'order_not_paid' };
    }

    // 9章「本人確認」: order.commonUserIdが未解決の間は送付を保留する(エラーにはしない・
    // Claim状態も変更しない=呼び出し元がCLAIMEDへ進めた分をPENDINGへ戻す)。
    if (order.commonUserResolutionStatus !== 'resolved' || !order.commonUserId) {
      await tx.walletClaim.update({ where: { id: claim.id }, data: { status: 'PENDING' } });
      await tx.walletClaimAuditLog.create({
        data: { walletClaimId: claim.id, orderId: order.id, eventType: 'common_user_unresolved' },
      });
      return { kind: 'common_user_unresolved' };
    }

    if (order.commonUserId !== input.commonUserId) {
      // 9章「不一致」: Claim非変更(PENDINGへ戻す)・Delivery非作成・AuditLog記録。
      await tx.walletClaim.update({ where: { id: claim.id }, data: { status: 'PENDING' } });
      await tx.walletClaimAuditLog.create({
        data: {
          walletClaimId: claim.id,
          orderId: order.id,
          eventType: 'common_user_mismatch',
          detail: { requestedCommonUserId: input.commonUserId, orderCommonUserId: order.commonUserId, phase: 'initial-confirm' },
        },
      });
      return { kind: 'common_user_mismatch' };
    }

    // 7章: 対象NftIssue一覧取得(digital_collectible対象商品のもののみ、キャンセル済みは除く)。
    const nftIssues = await tx.nftIssue.findMany({ where: { orderId: order.id, status: { not: 'cancelled' } } });
    const orderItems = await tx.orderItem.findMany({ where: { orderId: order.id } });
    const orderItemById = new Map(orderItems.map((item) => [item.id, item]));

    for (const nftIssue of nftIssues) {
      const orderItem = orderItemById.get(nftIssue.orderItemId);
      if (!orderItem) continue;
      const rule = await getDigitalCollectibleRule(tx, nftIssue.productId);
      if (!rule) continue;
      const product = await tx.product.findUnique({ where: { id: nftIssue.productId } });
      if (!product) continue;

      // 8章: NftIssue単位でCollectibleDelivery upsert(同時実行・リトライでの重複作成を防ぐ)。
      const delivery = await tx.collectibleDelivery.upsert({
        where: { nftIssueId: nftIssue.id },
        update: {},
        create: {
          walletClaimId: claim.id,
          nftIssueId: nftIssue.id,
          entitlementId: nftIssue.id,
          commonUserId: input.commonUserId,
          oveAccountId: input.oveAccountId,
          status: 'PENDING',
        },
      });

      // 9章: NftIssue単位でOutbox enqueue。既にoutbox_event_idが設定済み(リトライでの再入)なら
      // 二重enqueueしない。
      if (!delivery.outboxEventId) {
        const outboxEventId = await enqueueDigitalCollectibleEvent(tx, {
          order,
          orderItem,
          nftIssue,
          rule,
          product,
          commonUserId: input.commonUserId,
          eventType: 'entitlement.granted',
        });
        await tx.collectibleDelivery.update({ where: { id: delivery.id }, data: { outboxEventId } });
      }
    }

    // 10章: WalletClaim = DELIVERY_PENDING。
    await tx.walletClaim.update({
      where: { id: claim.id },
      data: {
        status: 'DELIVERY_PENDING',
        claimedAt: new Date(),
        commonUserId: input.commonUserId,
        oveAccountId: input.oveAccountId,
        lastError: null,
      },
    });

    return { kind: 'ok', status: 'DELIVERY_PENDING' };
  }).then(async (outcome) => {
    if (outcome.kind === 'ok') {
      // enqueueしたNftIssue単位Outboxをベストエフォートで即時ディスパッチする
      // (ENABLE_DIGITAL_COLLECTIBLE_DELIVERY=falseの間はdispatchPendingOutboxEvents自体が
      // SENNOKUNI_INTEGRATION_ENABLEDに従いno-opのため、ここでは呼び出しの是非を分岐しない)。
      await triggerImmediateOutboxDispatch();
    }
    return outcome;
  });
}
