import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { hashClaimToken } from './walletClaim';
import { enqueueDigitalCollectibleEvent } from './integrationOutbox';

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
  | { kind: 'no_claimable_items' } // 送付対象カードが0件(要確認・WalletClaimはERROR)
  | { kind: 'ok'; status: string; deliveryCount: number };

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)10章のトランザクション手順に対応する。
// 冪等性: 既にDELIVERY_PENDING/DELIVEREDの場合、同一common_user_idでの再確認はokを返し
// (Delivery・Outboxの重複作成はしない)、異なるcommon_user_idでの再確認はmismatchとして扱う。
//
// Wallet Claim本番前安定化指示書(2026-07-25)Phase3: このトランザクションはCollectibleDelivery・
// Integration Outbox・WalletClaim状態の確定までで完了する。実送信(Dispatcher)の同期呼び出しは
// 行わない(外部Wallet APIの遅延・タイムアウトがClaim確認APIの応答へ影響しないようにするため)。
// 送信自体は5分Cron(process-integration-outbox)に委ねる。
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
      const deliveryCount = await tx.collectibleDelivery.count({ where: { walletClaimId: claim.id } });
      return { kind: 'ok', status: claim.status, deliveryCount };
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

    // Wallet Claim本番前安定化指示書(2026-07-25)Phase4「Confirm時」: 送付対象の判断は決済確定時に
    // 作成済みのWalletClaimItem(購入時点のルール・商品スナップショット)のみを基準にする。現在の
    // ProductIntegrationRuleを再取得・再判定しない(購入後のルール変更・削除の影響を受けないため)。
    const claimItems = await tx.walletClaimItem.findMany({ where: { walletClaimId: claim.id, status: 'PENDING' } });
    const orderItems = await tx.orderItem.findMany({ where: { orderId: order.id } });
    const orderItemById = new Map(orderItems.map((item) => [item.id, item]));
    const nftIssues = await tx.nftIssue.findMany({ where: { id: { in: claimItems.map((item) => item.nftIssueId) } } });
    const nftIssueById = new Map(nftIssues.map((nftIssue) => [nftIssue.id, nftIssue]));

    let deliveryCount = 0;
    for (const claimItem of claimItems) {
      const orderItem = orderItemById.get(claimItem.orderItemId);
      const nftIssue = nftIssueById.get(claimItem.nftIssueId);
      if (!orderItem || !nftIssue) continue;
      // 返金等でNftIssue自体がcancelledになった行は送付しない。WalletClaimItem.status自体の
      // 同期(PENDING→CANCELLED)は最終安定化指示書Phase9で追加済みだが(claimItemsの
      // 絞り込み条件で既に除外されるはず)、念のためNftIssue.statusも併せて確認し二重に防ぐ。
      if (nftIssue.status === 'cancelled') continue;

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
      deliveryCount += 1;

      // 9章: NftIssue単位でOutbox enqueue。既にoutbox_event_idが設定済み(リトライでの再入)なら
      // 二重enqueueしない。
      if (!delivery.outboxEventId) {
        const outboxEventId = await enqueueDigitalCollectibleEvent(tx, {
          order,
          orderItem,
          nftIssue,
          claimItem,
          commonUserId: input.commonUserId,
          eventType: 'entitlement.granted',
        });
        await tx.collectibleDelivery.update({ where: { id: delivery.id }, data: { outboxEventId } });
      }
    }

    // Wallet Claim本番前安定化指示書(2026-07-25)6.5「Delivery 0件」: 対象カードが1件もない場合は
    // DELIVERY_PENDINGへ進めず、ERROR(要確認)のまま留める。
    if (deliveryCount === 0) {
      await tx.walletClaim.update({
        where: { id: claim.id },
        data: { status: 'ERROR', lastError: 'no_claimable_items' },
      });
      return { kind: 'no_claimable_items' };
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

    return { kind: 'ok', status: 'DELIVERY_PENDING', deliveryCount };
  });
}
