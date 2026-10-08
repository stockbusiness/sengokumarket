import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { parsePagination } from '../../shared/pagination/parsePagination';

const router = Router();

// 仕様書外の拡張(2026-10・緊急障害対応): 代理店SSOログイン失敗の一覧。Vercelの実行ログを
// 開けない(スマートフォンのみ等)状況でも管理画面から直接確認できるようにする。
router.get('/agency-sso-failures', async (req, res) => {
  const { page, pageSize, skip, take } = parsePagination(req.query);
  const [failures, total] = await Promise.all([
    prisma.agencySsoLoginFailureLog.findMany({ orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.agencySsoLoginFailureLog.count(),
  ]);
  res.json({ failures, total, page, pageSize });
});

export default router;
