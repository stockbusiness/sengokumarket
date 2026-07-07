import { Router } from 'express';
import { prisma } from '../../lib/prisma';

const router = Router();

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

router.get('/audit-logs', async (req, res) => {
  const page = Math.max(Number.parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(String(req.query.pageSize ?? ''), 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  const [logs, total] = await Promise.all([
    prisma.adminAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.adminAuditLog.count(),
  ]);

  res.json({ logs, total, page, pageSize });
});

export default router;
