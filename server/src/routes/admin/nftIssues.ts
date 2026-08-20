import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { NFT_ISSUE_STATUSES as STATUSES, type NftIssueStatus } from '@sengoku/contracts';
import { assertNftIssueTransition } from '../../shared/statusPolicy/nftIssueStatus.policy';
import { DomainError } from '../../shared/errors/domainError';
import { parsePagination } from '../../shared/pagination/parsePagination';
import { HttpError } from '../../lib/httpError';
import { getMintProvider } from '../../services/nftMint';
import { submitAndMaybeConfirm, type ProcessNftMintsResult } from '../../services/nftMintProcessing';
import { DIGITAL_COLLECTIBLE_DESTINATION, DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE } from '../../services/digitalCollectible';

const router = Router();
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
// 保留(cronの再試行対象から外す)は新規ステータスを増やさず、next_attempt_atを遠い未来に
// 設定することで表現する(仕様書外の拡張。nftMintProcessing.tsのバックオフと同じ仕組みを流用)。
const HOLD_DURATION_MS = 100 * 365 * 24 * 60 * 60 * 1000;

router.get('/nft-issues', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = status ? { status } : undefined;
  const [nftIssues, total] = await Promise.all([
    prisma.nftIssue.findMany({
      where,
      include: { order: true, product: true, variant: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.nftIssue.count({ where }),
  ]);

  // 仕様書外の拡張(運営手動Mint): ready_to_issueの行に、シリアル番号入力欄の初期値として
  // 「商品ごとのissued済み件数+1」を提案する(1クエリにまとめてN+1を避ける)。
  const readyProductIds = [...new Set(nftIssues.filter((i) => i.status === 'ready_to_issue').map((i) => i.productId))];
  const issuedCounts =
    readyProductIds.length > 0
      ? await prisma.nftIssue.groupBy({
          by: ['productId'],
          where: { productId: { in: readyProductIds }, status: 'issued' },
          _count: { _all: true },
        })
      : [];
  const issuedCountByProductId = new Map(issuedCounts.map((c) => [c.productId, c._count._all]));

  res.json({
    nftIssues: nftIssues.map((issue) => ({
      id: issue.id,
      orderNumber: issue.order.orderNumber,
      customerName: issue.order.customerName,
      productName: issue.product.name,
      variantName: issue.variant?.name ?? null,
      walletAddress: issue.walletAddress,
      status: issue.status,
      tokenId: issue.tokenId,
      transactionHash: issue.transactionHash,
      issuedAt: issue.issuedAt,
      adminNote: issue.adminNote,
      serialNumber: issue.serialNumber,
      suggestedSerialNumber: issue.status === 'ready_to_issue' ? (issuedCountByProductId.get(issue.productId) ?? 0) + 1 : null,
      // 仕様書外の拡張(NFT自動発行): 外部Mint API連携の状態表示用。
      attemptCount: issue.attemptCount,
      lastError: issue.lastError,
      submittedAt: issue.submittedAt,
      providerRequestId: issue.providerRequestId,
      nextAttemptAt: issue.nextAttemptAt,
    })),
    total,
    page,
    pageSize,
  });
});

// issuedへの変更はtoken_id / transaction_hashを必須とし、issued_atを自動記録する(仕様書v1.5 5.4 / 8章)。
router.put('/nft-issues/:id', async (req, res) => {
  const { status, tokenId, transactionHash, adminNote } = req.body ?? {};

  const existing = await prisma.nftIssue.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 404, 'NFT_ISSUE_NOT_FOUND', 'NFT発行データが見つかりません');

  if (status !== undefined && !STATUSES.includes(status)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ステータスが不正です');
  }

  if (status !== undefined) {
    try {
      assertNftIssueTransition(existing.status as NftIssueStatus, status);
    } catch (e) {
      if (e instanceof DomainError) return sendError(res, 409, e.code, e.message);
      throw e;
    }
  }

  if (status === 'issued') {
    const finalTokenId = tokenId ?? existing.tokenId;
    const finalTxHash = transactionHash ?? existing.transactionHash;
    if (!finalTokenId) return sendError(res, 400, 'VALIDATION_ERROR', 'token IDを入力してください');
    if (!finalTxHash || !TX_HASH_RE.test(finalTxHash)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'transaction hashの形式が正しくありません');
    }
  }

  const updated = await prisma.nftIssue.update({
    where: { id: req.params.id },
    data: {
      status: status ?? undefined,
      tokenId: tokenId !== undefined ? tokenId : undefined,
      transactionHash: transactionHash !== undefined ? transactionHash : undefined,
      adminNote: typeof adminNote === 'string' ? adminNote : undefined,
      issuedAt: status === 'issued' && !existing.issuedAt ? new Date() : undefined,
    },
  });

  res.json({ nftIssue: updated });
});

// 仕様書外の拡張(NFT自動発行): failedまたはバックオフ待ち(next_attempt_atが未来)の行を
// 次回cron/決済確定時の即時実行対象に戻す。failedの場合はready_to_issueへも戻す。
router.post('/nft-issues/:id/retry', async (req, res) => {
  const existing = await prisma.nftIssue.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 404, 'NFT_ISSUE_NOT_FOUND', 'NFT発行データが見つかりません');
  if (existing.status !== 'failed' && existing.status !== 'ready_to_issue') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'この状態からは再試行できません');
  }

  const updated = await prisma.nftIssue.update({
    where: { id: req.params.id },
    data: { status: 'ready_to_issue', nextAttemptAt: null },
  });

  res.json({ nftIssue: updated });
});

// 仕様書外の拡張(運営手動Mint): ready_to_issueの行を、運営が確認したシリアル番号で
// 外部Mint APIへ送信する。cronの自動claimは廃止したため、送信のトリガーはこの操作のみ。
router.post('/nft-issues/:id/mint', async (req, res) => {
  const serialNumber = Number(req.body?.serialNumber);
  if (!Number.isInteger(serialNumber) || serialNumber <= 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'シリアル番号は正の整数で入力してください');
  }

  const existing = await prisma.nftIssue.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 404, 'NFT_ISSUE_NOT_FOUND', 'NFT発行データが見つかりません');
  if (existing.status !== 'ready_to_issue') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'この状態からは発行できません');
  }
  if (existing.nextAttemptAt && existing.nextAttemptAt > new Date()) {
    return sendError(res, 400, 'VALIDATION_ERROR', '保留中、またはバックオフ待ちのため発行できません');
  }

  // digital_collectible対象商品はWalletClaim経由の別フローで送付するため、本来この状態には
  // 到達しないはずだが、二重の安全策としてここでも明示的に拒否する。
  const digitalCollectibleRule = await prisma.productIntegrationRule.findFirst({
    where: {
      productId: existing.productId,
      enabled: true,
      entitlementTargetSystemKey: DIGITAL_COLLECTIBLE_DESTINATION,
      entitlementType: DIGITAL_COLLECTIBLE_ENTITLEMENT_TYPE,
    },
  });
  if (digitalCollectibleRule) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'この商品は別の受け渡し経路(デジタル引換券)のため、この画面からは発行できません');
  }

  // 他の同時操作に先を越されていないかを条件付きUPDATEでアトミックに確認する。
  const claimedCount = await prisma.$executeRaw`
    UPDATE nft_issues SET status = 'processing', updated_at = now()
    WHERE id = ${req.params.id}::uuid AND status = 'ready_to_issue'
  `;
  if (claimedCount === 0) {
    return sendError(res, 409, 'NFT_ISSUE_ALREADY_CLAIMED', '他の操作により既に処理中です');
  }

  const provider = getMintProvider();
  const result: ProcessNftMintsResult = { claimed: 1, issued: 0, stillProcessing: 0, retrying: 0, failed: 0, skipped: 0 };
  try {
    await submitAndMaybeConfirm(req.params.id, provider, result, serialNumber);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }

  const updated = await prisma.nftIssue.findUniqueOrThrow({ where: { id: req.params.id } });
  res.json({ nftIssue: updated });
});

// 仕様書外の拡張(NFT自動発行): next_attempt_atを遠い未来に設定し、新規ステータスを増やさずに
// cronの再試行対象から一時的に除外する(保留)。
router.post('/nft-issues/:id/hold', async (req, res) => {
  const existing = await prisma.nftIssue.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 404, 'NFT_ISSUE_NOT_FOUND', 'NFT発行データが見つかりません');
  if (existing.status !== 'ready_to_issue' && existing.status !== 'failed') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'この状態からは保留できません');
  }

  const updated = await prisma.nftIssue.update({
    where: { id: req.params.id },
    data: { status: 'ready_to_issue', nextAttemptAt: new Date(Date.now() + HOLD_DURATION_MS) },
  });

  res.json({ nftIssue: updated });
});

export default router;
