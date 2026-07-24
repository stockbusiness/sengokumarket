import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { NOTIFICATION_OUTBOX_STATUSES as STATUSES } from '@sengoku/contracts';
import { parsePagination } from '../../shared/pagination/parsePagination';
import { retryNotification } from '../../modules/notifications/application/dispatchNotificationOutbox.usecase';

const router = Router();

// 残課題指示書Stage3・5.6: 代理店設定メール等のnotification_outbox_eventsの送信状況一覧。
router.get('/notification-outbox', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ステータスが不正です');
  }

  const { page, pageSize, skip, take } = parsePagination(req.query);
  const where = status ? { status } : undefined;
  const [events, total] = await Promise.all([
    prisma.notificationOutboxEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.notificationOutboxEvent.count({ where }),
  ]);

  res.json({ notificationOutboxEvents: events, total, page, pageSize });
});

// 手動再送(送信失敗・dead化したイベントの復旧用)。
router.post('/notification-outbox/:id/retry', async (req, res) => {
  const result = await retryNotification(req.params.id);
  if (!result.ok) {
    return sendError(res, 404, 'NOT_FOUND', '再送可能な通知が見つかりません');
  }
  res.json(result);
});

export default router;
