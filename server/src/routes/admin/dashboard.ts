import { Router } from 'express';
import { prisma } from '../../lib/prisma';

const router = Router();

router.get('/dashboard', async (_req, res) => {
  const [
    salesAgg,
    orderCount,
    paidCount,
    nftPendingCount,
    walletMissingCount,
    variants,
    referralSalesAgg,
    pendingCommissionAgg,
    partialRefundCount,
    commissionRecoveryCount,
  ] = await Promise.all([
    prisma.order.aggregate({ where: { paymentStatus: 'paid' }, _sum: { totalAmount: true } }),
    prisma.order.count(),
    prisma.order.count({ where: { paymentStatus: 'paid' } }),
    prisma.nftIssue.count({ where: { status: { in: ['wallet_required', 'ready_to_issue'] } } }),
    prisma.nftIssue.count({ where: { status: 'wallet_required' } }),
    prisma.productVariant.findMany({ include: { product: true } }),
    prisma.order.aggregate({
      where: { paymentStatus: 'paid', referralLinkId: { not: null } },
      _sum: { totalAmount: true },
    }),
    prisma.commission.aggregate({ where: { status: 'pending' }, _sum: { commissionAmount: true } }),
    prisma.order.count({ where: { adminNote: { contains: '一部返金検知' } } }),
    prisma.commission.count({ where: { adminNote: { contains: '要回収' } } }),
  ]);

  const agencyTop5Raw = await prisma.order.groupBy({
    by: ['agencyId'],
    where: { paymentStatus: 'paid', agencyId: { not: null } },
    _sum: { totalAmount: true },
    orderBy: { _sum: { totalAmount: 'desc' } },
    take: 5,
  });
  const agencies = await prisma.agency.findMany({
    where: { id: { in: agencyTop5Raw.map((a) => a.agencyId!) } },
  });
  const agencyById = new Map(agencies.map((a) => [a.id, a]));

  res.json({
    totalSales: salesAgg._sum.totalAmount ?? 0,
    orderCount,
    paidCount,
    nftPendingCount,
    walletMissingCount,
    stockByVariant: variants.map((v) => ({
      productName: v.product.name,
      variantName: v.name,
      stock: v.stock,
      reservedStock: v.reservedStock,
      availableStock: v.stock - v.reservedStock,
    })),
    referralSales: referralSalesAgg._sum.totalAmount ?? 0,
    agencyTop5: agencyTop5Raw.map((a) => ({
      agencyId: a.agencyId,
      agencyName: agencyById.get(a.agencyId!)?.name ?? '不明',
      totalSales: a._sum.totalAmount ?? 0,
    })),
    pendingCommissionTotal: pendingCommissionAgg._sum.commissionAmount ?? 0,
    alerts: {
      partialRefundCount,
      commissionRecoveryCount,
    },
  });
});

// 仕様書外の拡張: 月別の売上推移(直近Nヶ月、既定6・最大12)。
router.get('/dashboard/sales-trend', async (req, res) => {
  const months = Math.min(Math.max(Number.parseInt(String(req.query.months ?? '6'), 10) || 6, 1), 12);

  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);

  const rows = await prisma.$queryRaw<{ month: Date; total_sales: number; order_count: number }[]>`
    SELECT date_trunc('month', paid_at) AS month, SUM(total_amount)::int AS total_sales, COUNT(*)::int AS order_count
    FROM orders
    WHERE payment_status = 'paid' AND paid_at >= ${cutoff}
    GROUP BY 1
    ORDER BY 1
  `;
  const byMonth = new Map(rows.map((r) => [r.month.toISOString().slice(0, 7), r]));

  const trend = Array.from({ length: months }, (_, i) => {
    const d = new Date(cutoff.getFullYear(), cutoff.getMonth() + i, 1);
    const key = d.toISOString().slice(0, 7);
    const row = byMonth.get(key);
    return { month: key, totalSales: row?.total_sales ?? 0, orderCount: row?.order_count ?? 0 };
  });

  res.json({ trend });
});

export default router;
