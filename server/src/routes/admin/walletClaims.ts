import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { parsePagination } from '../../shared/pagination/parsePagination';
import { reissueWalletClaimToken } from '../../services/walletClaim';
import { getWalletClaimWebBaseUrl } from '../../services/walletClaimConfig';
import { sendWalletClaimReissuedEmail } from '../../services/mailTemplates';

const router = Router();

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)19章「管理画面」。
// 検索: order number・claim status・common_user_id・ove_account_id。
// 禁止事項(19章・22章): 生Token表示・Delivered直接巻き戻し・entitlement_id変更・NftIssue物理削除は
// この画面(および下のcollectibleDeliveries.ts)からは一切行えない設計にする。
router.get('/wallet-claims', async (req, res) => {
  const { orderNumber, status, commonUserId, oveAccountId } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where: Prisma.WalletClaimWhereInput = {};
  if (typeof status === 'string' && status) where.status = status;
  if (typeof commonUserId === 'string' && commonUserId) where.commonUserId = { contains: commonUserId };
  if (typeof oveAccountId === 'string' && oveAccountId) where.oveAccountId = { contains: oveAccountId };
  if (typeof orderNumber === 'string' && orderNumber) {
    where.order = { orderNumber: { contains: orderNumber } };
  }

  const [claims, total] = await Promise.all([
    prisma.walletClaim.findMany({
      where,
      include: { order: true, deliveries: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.walletClaim.count({ where }),
  ]);

  res.json({
    walletClaims: claims.map((claim) => ({
      id: claim.id,
      orderId: claim.orderId,
      orderNumber: claim.order.orderNumber,
      customerName: claim.order.customerName,
      status: claim.status,
      expiresAt: claim.expiresAt,
      claimedAt: claim.claimedAt,
      commonUserId: claim.commonUserId,
      oveAccountId: claim.oveAccountId,
      lastError: claim.lastError,
      deliveryCount: claim.deliveries.length,
      deliveredCount: claim.deliveries.filter((d) => d.status === 'DELIVERED').length,
      createdAt: claim.createdAt,
    })),
    total,
    page,
    pageSize,
  });
});

router.get('/wallet-claims/:id', async (req, res) => {
  const claim = await prisma.walletClaim.findUnique({
    where: { id: req.params.id },
    include: {
      order: true,
      deliveries: { include: { nftIssue: { include: { product: true } } }, orderBy: { createdAt: 'asc' } },
      auditLogs: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!claim) return sendError(res, 404, 'WALLET_CLAIM_NOT_FOUND', 'Claimが見つかりません');

  res.json({
    walletClaim: {
      id: claim.id,
      orderId: claim.orderId,
      orderNumber: claim.order.orderNumber,
      customerName: claim.order.customerName,
      customerEmail: claim.order.customerEmail,
      status: claim.status,
      expiresAt: claim.expiresAt,
      claimedAt: claim.claimedAt,
      commonUserId: claim.commonUserId,
      oveAccountId: claim.oveAccountId,
      lastError: claim.lastError,
      createdAt: claim.createdAt,
      updatedAt: claim.updatedAt,
      deliveries: claim.deliveries.map((d) => ({
        id: d.id,
        nftIssueId: d.nftIssueId,
        entitlementId: d.entitlementId,
        productName: d.nftIssue.product.name,
        serialNumber: d.nftIssue.serialNumber,
        commonUserId: d.commonUserId,
        oveAccountId: d.oveAccountId,
        status: d.status,
        deliveredAt: d.deliveredAt,
        revokedAt: d.revokedAt,
        lastError: d.lastError,
        outboxEventId: d.outboxEventId,
      })),
      auditLogs: claim.auditLogs.map((a) => ({
        id: a.id,
        eventType: a.eventType,
        detail: a.detail,
        createdAt: a.createdAt,
      })),
    },
  });
});

// 19章「操作: Claim再発行」。生トークンは画面へ返さず、注文の登録メールアドレスへ直接送付する
// (22章「生Token表示」禁止に抵触しないため)。
router.post('/wallet-claims/:id/reissue', async (req, res) => {
  const claim = await prisma.walletClaim.findUnique({ where: { id: req.params.id }, include: { order: true } });
  if (!claim) return sendError(res, 404, 'WALLET_CLAIM_NOT_FOUND', 'Claimが見つかりません');

  const token = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, claim.orderId));
  if (!token) {
    return sendError(res, 400, 'WALLET_CLAIM_NOT_REISSUABLE', '現在の状態では再発行できません');
  }

  const base = await getWalletClaimWebBaseUrl();
  if (!base) {
    return sendError(res, 503, 'WALLET_CLAIM_URL_NOT_CONFIGURED', '受取URLの設定が完了していません');
  }

  await sendWalletClaimReissuedEmail(claim.order.customerEmail, claim.order.customerName, `${base}/claim/${token}`);

  res.json({ ok: true, sentTo: claim.order.customerEmail });
});

export default router;
