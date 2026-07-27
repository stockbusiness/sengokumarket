import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { parsePagination } from '../../shared/pagination/parsePagination';
import { retryOutboxEvent } from '../../services/integrationOutboxDispatcher';

const router = Router();

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)19章「管理画面」。
// 検索: nft_issue_id・entitlement_id・delivery status・common_user_id・ove_account_id・
// order number(WalletClaim経由)。
router.get('/collectible-deliveries', async (req, res) => {
  const { nftIssueId, entitlementId, status, commonUserId, oveAccountId, orderNumber } = req.query;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where: Prisma.CollectibleDeliveryWhereInput = {};
  if (typeof nftIssueId === 'string' && nftIssueId) where.nftIssueId = nftIssueId;
  if (typeof entitlementId === 'string' && entitlementId) where.entitlementId = entitlementId;
  if (typeof status === 'string' && status) where.status = status;
  if (typeof commonUserId === 'string' && commonUserId) where.commonUserId = { contains: commonUserId };
  if (typeof oveAccountId === 'string' && oveAccountId) where.oveAccountId = { contains: oveAccountId };
  if (typeof orderNumber === 'string' && orderNumber) {
    where.walletClaim = { order: { orderNumber: { contains: orderNumber } } };
  }

  const [deliveries, total] = await Promise.all([
    prisma.collectibleDelivery.findMany({
      where,
      include: { nftIssue: { include: { product: true } }, walletClaim: { include: { order: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.collectibleDelivery.count({ where }),
  ]);

  res.json({
    collectibleDeliveries: deliveries.map((d) => ({
      id: d.id,
      orderNumber: d.walletClaim.order.orderNumber,
      walletClaimId: d.walletClaimId,
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
      createdAt: d.createdAt,
    })),
    total,
    page,
    pageSize,
  });
});

router.get('/collectible-deliveries/:id', async (req, res) => {
  const delivery = await prisma.collectibleDelivery.findUnique({
    where: { id: req.params.id },
    include: { nftIssue: { include: { product: true, order: true } }, walletClaim: { include: { order: true } }, outboxEvent: true },
  });
  if (!delivery) return sendError(res, 404, 'COLLECTIBLE_DELIVERY_NOT_FOUND', 'Deliveryが見つかりません');

  const attempts = delivery.outboxEventId
    ? await prisma.integrationEventAttempt.findMany({ where: { outboxEventId: delivery.outboxEventId }, orderBy: { attemptNumber: 'asc' } })
    : [];

  res.json({
    collectibleDelivery: {
      id: delivery.id,
      orderNumber: delivery.walletClaim.order.orderNumber,
      walletClaimId: delivery.walletClaimId,
      nftIssueId: delivery.nftIssueId,
      entitlementId: delivery.entitlementId,
      productName: delivery.nftIssue.product.name,
      serialNumber: delivery.nftIssue.serialNumber,
      nftIssueStatus: delivery.nftIssue.status,
      commonUserId: delivery.commonUserId,
      oveAccountId: delivery.oveAccountId,
      status: delivery.status,
      deliveredAt: delivery.deliveredAt,
      revokedAt: delivery.revokedAt,
      lastError: delivery.lastError,
      outboxEventId: delivery.outboxEventId,
      outboxEventStatus: delivery.outboxEvent?.status ?? null,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
      attempts: attempts.map((a) => ({
        id: a.id,
        attemptNumber: a.attemptNumber,
        startedAt: a.startedAt,
        finishedAt: a.finishedAt,
        httpStatus: a.httpStatus,
        result: a.result,
        error: a.error,
        destinationUrl: a.destinationUrl,
        responseBodyExcerpt: a.responseBodyExcerpt,
      })),
    },
  });
});

// 19章「操作: failed/dead再送」。DELIVERED(既に送付済み)の直接巻き戻しは行わない
// (22章禁止事項)。
router.post('/collectible-deliveries/:id/retry', async (req, res) => {
  const delivery = await prisma.collectibleDelivery.findUnique({ where: { id: req.params.id } });
  if (!delivery) return sendError(res, 404, 'COLLECTIBLE_DELIVERY_NOT_FOUND', 'Deliveryが見つかりません');
  if (delivery.status !== 'FAILED' && delivery.status !== 'DEAD') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'failedまたはdead状態のみ再送できます');
  }
  if (!delivery.outboxEventId) {
    return sendError(res, 400, 'VALIDATION_ERROR', '送信対象のOutboxイベントが見つかりません');
  }

  const result = await retryOutboxEvent(delivery.outboxEventId);
  if (!result.ok) {
    return sendError(res, 400, 'RETRY_FAILED', '再送できませんでした(Feature Flag無効・処理中等)');
  }

  const updated = await prisma.collectibleDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
  res.json({ ok: true, status: updated.status });
});

export default router;
