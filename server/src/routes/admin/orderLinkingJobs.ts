import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { ORDER_LINKING_JOB_STATUSES as STATUSES } from '@sengoku/contracts';
import { parsePagination } from '../../shared/pagination/parsePagination';
import { countOrderLinkingJobsBacklog, retryOrderLinkingJob, skipOrderLinkingJob } from '../../services/orderLinkingJobDispatcher';

const router = Router();

// 本番安定化指示書Stage5(8.6): common_user_id解決・referral capture/confirmジョブの一覧・
// 手動再送・skip・backlog件数確認。既存のintegration-outbox管理APIと同じ設計を踏襲する。

// 具体的なパス(backlog)を:idより先に定義する(Expressのルート解決順に依存)。
router.get('/order-linking-jobs/backlog', async (_req, res) => {
  const backlog = await countOrderLinkingJobsBacklog();
  res.json(backlog);
});

router.get('/order-linking-jobs', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ステータスが不正です');
  }

  // 本番安定化指示書Stage11(14.1「External Identity conflicts」画面): common_user_id_conflict
  // で止まっているジョブだけを一覧できるようにする(PR-10で追加されたblocked理由)。
  const blockedReason = typeof req.query.blockedReason === 'string' ? req.query.blockedReason : undefined;

  const { page, pageSize, skip, take } = parsePagination(req.query);
  const where = { ...(status ? { status } : {}), ...(blockedReason ? { blockedReason } : {}) };
  const [jobs, total] = await Promise.all([
    prisma.orderLinkingJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.orderLinkingJob.count({ where }),
  ]);

  res.json({ jobs, total, page, pageSize });
});

router.post('/order-linking-jobs/:id/retry', async (req, res) => {
  const result = await retryOrderLinkingJob(req.params.id);
  if (!result.ok) {
    return sendError(res, 404, 'NOT_FOUND', '再送可能なジョブが見つかりません');
  }
  res.json(result);
});

// 依存の解決が見込めない等の理由で、実送信を試みずに処理対象から外す(succeeded/failed/dead
// とは異なる専用の終端状態にする)。
router.post('/order-linking-jobs/:id/skip', async (req, res) => {
  const result = await skipOrderLinkingJob(req.params.id);
  if (!result.ok) {
    return sendError(res, 404, 'NOT_FOUND', 'skip可能なジョブが見つかりません');
  }
  res.json(result);
});

export default router;
