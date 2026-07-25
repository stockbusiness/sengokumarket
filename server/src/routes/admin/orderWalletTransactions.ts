import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { parsePagination } from '../../shared/pagination/parsePagination';

const router = Router();

// 本番安定化指示書Stage10(13.5「管理画面で確認可能」): OVE Wallet向けgrant/reversalの
// 追跡専用テーブルの一覧確認API。編集・削除は行わない(このテーブルは外部への実送信結果の
// 記録であり、注文の紹介コード同様、後から書き換える機能は設けない)。
router.get('/order-wallet-transactions', async (req, res) => {
  const orderId = typeof req.query.orderId === 'string' ? req.query.orderId : undefined;
  const orderItemId = typeof req.query.orderItemId === 'string' ? req.query.orderItemId : undefined;
  const commonUserId = typeof req.query.commonUserId === 'string' ? req.query.commonUserId : undefined;

  const { page, pageSize, skip, take } = parsePagination(req.query);
  const where = {
    ...(orderId ? { orderId } : {}),
    ...(orderItemId ? { orderItemId } : {}),
    ...(commonUserId ? { commonUserId } : {}),
  };

  const [transactions, total] = await Promise.all([
    prisma.orderWalletTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.orderWalletTransaction.count({ where }),
  ]);

  res.json({ transactions, total, page, pageSize });
});

export default router;
