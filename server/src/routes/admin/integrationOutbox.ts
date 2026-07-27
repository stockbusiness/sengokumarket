import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { INTEGRATION_OUTBOX_STATUSES as STATUSES } from '@sengoku/contracts';
import { parsePagination } from '../../shared/pagination/parsePagination';
import { retryOutboxEvent } from '../../services/integrationOutboxDispatcher';

const router = Router();

// 仕様書外の拡張(千ノ国全体統合契約2026-07-21・管理画面「連携管理」相当): 下流システムへの
// イベント送信状況を一覧できるようにする。現時点では送信先の実エンドポイントが未確定のため
// 常にpendingのままだが、Outboxへの記録自体(決済確定と連動しているか)を確認できるようにする。
router.get('/integration-outbox', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ステータスが不正です');
  }
  const destinationSystemKey = typeof req.query.destinationSystemKey === 'string' ? req.query.destinationSystemKey : undefined;
  // 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)19章「Digital Collectible Outbox」:
  // 専用の一覧画面を新設する代わりに、この既存の汎用一覧へentitlement_id検索を追加し、
  // クライアント側でdestinationSystemKey=ove-wallet固定のフィルタ済みビューとして再利用する。
  const entitlementId = typeof req.query.entitlementId === 'string' ? req.query.entitlementId : undefined;

  const { page, pageSize, skip, take } = parsePagination(req.query);
  const where: Prisma.IntegrationOutboxEventWhereInput = {};
  if (status) where.status = status;
  if (destinationSystemKey) where.destinationSystemKey = destinationSystemKey;
  if (entitlementId) where.deliveryPayload = { path: ['entitlement_id'], equals: entitlementId };

  const [events, total] = await Promise.all([
    prisma.integrationOutboxEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.integrationOutboxEvent.count({ where }),
  ]);

  res.json({ outboxEvents: events, total, page, pageSize });
});

// 本番安定化指示書Stage11(14.1「Integration Attempts」・14.4「試行履歴を確認可能」):
// 個別イベントの送信試行履歴(integration_event_attempts)をDB直接操作なしで確認できるようにする。
router.get('/integration-outbox/:id/attempts', async (req, res) => {
  const event = await prisma.integrationOutboxEvent.findUnique({ where: { id: req.params.id } });
  if (!event) return sendError(res, 404, 'NOT_FOUND', 'イベントが見つかりません');

  const attempts = await prisma.integrationEventAttempt.findMany({
    where: { outboxEventId: req.params.id },
    orderBy: { attemptNumber: 'asc' },
  });
  res.json({ attempts });
});

// 残課題指示書Stage7・9.2「手動再送」: dead/failed/blocked/pendingイベントの手動再送。
router.post('/integration-outbox/:id/retry', async (req, res) => {
  const result = await retryOutboxEvent(req.params.id);
  if (!result.ok) {
    return sendError(res, 404, 'NOT_FOUND', '再送可能なイベントが見つかりません');
  }
  res.json(result);
});

export default router;
