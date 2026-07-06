import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';

const router = Router();

const ORDER_STATUSES = ['pending', 'paid', 'cancelled', 'refunded'];

function serializeOrder(order: {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  totalAmount: number;
  paymentStatus: string;
  orderStatus: string;
  paidAt: Date | null;
  referralCode: string | null;
  agencyName: string | null;
  referrerName: string | null;
  commissionAmount: number;
  commissionStatus: string;
  adminNote: string | null;
  createdAt: Date;
}) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    totalAmount: order.totalAmount,
    paymentStatus: order.paymentStatus,
    orderStatus: order.orderStatus,
    paidAt: order.paidAt,
    referralCode: order.referralCode,
    agencyName: order.agencyName,
    referrerName: order.referrerName,
    commissionAmount: order.commissionAmount,
    commissionStatus: order.commissionStatus,
    adminNote: order.adminNote,
    createdAt: order.createdAt,
  };
}

router.get('/orders', async (_req, res) => {
  const orders = await prisma.order.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ orders: orders.map(serializeOrder) });
});

router.get('/orders/:id', async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { orderItems: true, nftIssues: true },
  });
  if (!order) return sendError(res, 404, 'ORDER_NOT_FOUND', '注文が見つかりません');
  res.json({ order });
});

// 紹介コード(referral_code等)は変更不可。orderStatusとadmin_noteのみ更新する(仕様書v1.5 5.3 / 9.8)。
router.put('/orders/:id', async (req, res) => {
  const { orderStatus, adminNote } = req.body ?? {};

  if (orderStatus !== undefined && !ORDER_STATUSES.includes(orderStatus)) {
    return sendError(res, 400, 'VALIDATION_ERROR', '注文ステータスが不正です');
  }

  const existing = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 404, 'ORDER_NOT_FOUND', '注文が見つかりません');

  const updated = await prisma.order.update({
    where: { id: req.params.id },
    data: {
      orderStatus: orderStatus ?? undefined,
      adminNote: typeof adminNote === 'string' ? adminNote : undefined,
    },
  });

  res.json({ order: serializeOrder(updated) });
});

export default router;
