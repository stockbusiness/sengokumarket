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

export default router;
