import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';

const router = Router();

const STATUSES = ['pending', 'processing', 'succeeded', 'failed', 'dead'];

// 仕様書外の拡張(千ノ国全体統合契約2026-07-21・管理画面「連携管理」相当): 下流システムへの
// イベント送信状況を一覧できるようにする。現時点では送信先の実エンドポイントが未確定のため
// 常にpendingのままだが、Outboxへの記録自体(決済確定と連動しているか)を確認できるようにする。
router.get('/integration-outbox', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status !== undefined && !STATUSES.includes(status)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ステータスが不正です');
  }

  const events = await prisma.integrationOutboxEvent.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  res.json({ outboxEvents: events });
});

export default router;
