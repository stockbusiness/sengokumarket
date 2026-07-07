import { Router } from 'express';
import { prisma } from '../../lib/prisma';

const router = Router();

// 代理店ポータルでは「自分の紹介で誰が何を買ったか」のみを見せる(仕様書外の拡張)。
// 報酬額・報酬率・報酬ステータスは対象外(将来実装。管理画面側でのみ扱う)。
router.get('/orders', async (req, res) => {
  const agencyId = req.authUser!.agencyId!;
  const orders = await prisma.order.findMany({
    where: { agencyId },
    orderBy: { createdAt: 'desc' },
    include: { orderItems: true },
  });

  res.json({
    orders: orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      totalAmount: order.totalAmount,
      paymentStatus: order.paymentStatus,
      createdAt: order.createdAt,
      items: order.orderItems.map((item) => ({
        productName: item.productName,
        variantName: item.variantName,
        quantity: item.quantity,
      })),
    })),
  });
});

export default router;
