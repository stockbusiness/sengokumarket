import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { PURCHASE_PROVISIONING_JOB_STATUSES as STATUSES } from '@sengoku/contracts';
import { parsePagination } from '../../shared/pagination/parsePagination';
import {
  countPurchaseProvisioningBacklog,
  retryPurchaseProvisioningJob,
  skipPurchaseProvisioningJob,
} from '../../services/purchaseProvisioningDispatcher';

const router = Router();

// 購入後代理店システム連携実装指示書 6.13章「管理画面」: order_linking_jobs・
// integration_outbox_eventsと同じ設計(一覧・手動再送・skip・backlog件数)を踏襲する。

router.get('/purchase-provisioning-jobs/backlog', async (_req, res) => {
  const backlog = await countPurchaseProvisioningBacklog();
  res.json(backlog);
});

router.get('/purchase-provisioning-jobs', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ステータスが不正です');
  }
  const action = typeof req.query.action === 'string' ? req.query.action : undefined;
  if (action !== undefined && action !== 'provision' && action !== 'revoke') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'actionが不正です');
  }

  // 6.13章「検索」: order number・email・common_user_id等での検索。orderに対する
  // 検索条件はrelationフィルタとして渡す。
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;

  const { page, pageSize, skip, take } = parsePagination(req.query);
  const where = {
    ...(status ? { status } : {}),
    ...(action ? { action } : {}),
    ...(search
      ? {
          OR: [
            { commonUserId: { contains: search, mode: 'insensitive' as const } },
            { order: { orderNumber: { contains: search, mode: 'insensitive' as const } } },
            { order: { customerEmail: { contains: search, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };
  const [jobs, total] = await Promise.all([
    prisma.purchaseProvisioningJob.findMany({
      where,
      include: { order: { select: { orderNumber: true, customerEmail: true, agencyAccountType: true, agencyLoginUrl: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.purchaseProvisioningJob.count({ where }),
  ]);

  res.json({ jobs, total, page, pageSize });
});

router.post('/purchase-provisioning-jobs/:id/retry', async (req, res) => {
  const result = await retryPurchaseProvisioningJob(req.params.id);
  if (!result.ok) {
    return sendError(res, 404, 'NOT_FOUND', '再送可能なジョブが見つかりません');
  }
  res.json(result);
});

router.post('/purchase-provisioning-jobs/:id/skip', async (req, res) => {
  const result = await skipPurchaseProvisioningJob(req.params.id);
  if (!result.ok) {
    return sendError(res, 404, 'NOT_FOUND', 'skip可能なジョブが見つかりません');
  }
  res.json(result);
});

export default router;
