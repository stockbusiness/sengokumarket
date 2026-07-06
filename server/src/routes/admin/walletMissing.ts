import { Router } from 'express';
import { prisma } from '../../lib/prisma';

const router = Router();

router.get('/wallet-missing', async (_req, res) => {
  const nftIssues = await prisma.nftIssue.findMany({
    where: { status: 'wallet_required' },
    include: { order: true, product: true },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    walletMissing: nftIssues.map((issue) => ({
      customerName: issue.order.customerName,
      customerEmail: issue.order.customerEmail,
      orderNumber: issue.order.orderNumber,
      productName: issue.product.name,
      purchasedAt: issue.order.paidAt ?? issue.order.createdAt,
    })),
  });
});

export default router;
