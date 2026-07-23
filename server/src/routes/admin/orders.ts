import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { buildCsv } from '../../lib/csv';
import { HttpError } from '../../lib/httpError';
import { confirmBankTransferPayment } from '../../services/bankTransfer';
import { matchExplainerName } from '../../services/explainerMatch';
import { ORDER_STATUSES } from '@sengoku/contracts';

const router = Router();

function serializeOrder(order: {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  totalAmount: number;
  paymentStatus: string;
  orderStatus: string;
  paymentMethod: string;
  paidAt: Date | null;
  referralCode: string | null;
  agencyName: string | null;
  referrerName: string | null;
  commissionAmount: number;
  commissionStatus: string;
  adminNote: string | null;
  createdAt: Date;
  // 仕様書外の拡張: 代理店階層の紐付け記録(報酬計算には使わない)と説明責任者。
  referralHierarchy: unknown;
  explainerName: string | null;
  explainerAgencyId: string | null;
  explainerInfluencerId: string | null;
}) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    totalAmount: order.totalAmount,
    paymentStatus: order.paymentStatus,
    orderStatus: order.orderStatus,
    paymentMethod: order.paymentMethod,
    paidAt: order.paidAt,
    referralCode: order.referralCode,
    agencyName: order.agencyName,
    referrerName: order.referrerName,
    commissionAmount: order.commissionAmount,
    commissionStatus: order.commissionStatus,
    adminNote: order.adminNote,
    createdAt: order.createdAt,
    referralHierarchy: order.referralHierarchy,
    explainerName: order.explainerName,
    explainerMatched: Boolean(order.explainerAgencyId || order.explainerInfluencerId),
  };
}

router.get('/orders', async (_req, res) => {
  const orders = await prisma.order.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ orders: orders.map(serializeOrder) });
});

// 仕様書外の拡張: 注文一覧のCSVエクスポート。
router.get('/orders/export.csv', async (_req, res) => {
  const orders = await prisma.order.findMany({
    include: { orderItems: true },
    orderBy: { createdAt: 'desc' },
  });

  const rows = orders.map((o) => [
    o.orderNumber,
    o.createdAt.toISOString(),
    o.paidAt?.toISOString() ?? '',
    o.customerName,
    o.customerEmail,
    o.orderItems.map((i) => `${i.productName}${i.variantName ? ` ${i.variantName}` : ''} × ${i.quantity}`).join(' / '),
    o.totalAmount,
    o.paymentMethod === 'bank_transfer' ? '銀行振込' : 'クレジットカード',
    o.paymentStatus,
    o.orderStatus,
    o.referralCode ?? '',
    o.agencyName ?? o.referrerName ?? '',
    o.commissionAmount,
    o.commissionStatus,
    o.adminNote ?? '',
  ]);

  const csv = buildCsv(
    [
      '注文番号',
      '注文日',
      '決済日',
      '購入者名',
      '購入者メール',
      '商品明細',
      '合計金額(税込)',
      '決済方法',
      '決済ステータス',
      '注文ステータス',
      '紹介コード',
      '代理店/紹介元',
      '報酬予定額',
      '報酬ステータス',
      '管理メモ',
    ],
    rows,
  );

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// 説明責任者が名簿と一致している場合、表示用に一致先の名前・種別を解決する。
async function resolveExplainerDisplay(order: { explainerAgencyId: string | null; explainerInfluencerId: string | null }) {
  if (order.explainerAgencyId) {
    const agency = await prisma.agency.findUnique({ where: { id: order.explainerAgencyId }, select: { name: true } });
    return agency ? { type: 'agency' as const, name: agency.name } : null;
  }
  if (order.explainerInfluencerId) {
    const influencer = await prisma.influencer.findUnique({ where: { id: order.explainerInfluencerId }, select: { name: true } });
    return influencer ? { type: 'influencer' as const, name: influencer.name } : null;
  }
  return null;
}

router.get('/orders/:id', async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { orderItems: true, nftIssues: true },
  });
  if (!order) return sendError(res, 404, 'ORDER_NOT_FOUND', '注文が見つかりません');
  const explainerMatch = await resolveExplainerDisplay(order);
  res.json({ order: { ...order, explainerMatch } });
});

// 紹介コード(referral_code等)は変更不可。orderStatus・admin_note・explainer_nameのみ更新する
// (仕様書v1.5 5.3 / 9.8)。explainer_nameは紹介コードとは独立した「説明責任者記録」であり、
// 報酬計算に使うagencyId/influencerId/referralLinkId/commissionRate等は一切変更しない。
router.put('/orders/:id', async (req, res) => {
  const { orderStatus, adminNote, explainerName } = req.body ?? {};

  if (orderStatus !== undefined && !ORDER_STATUSES.includes(orderStatus)) {
    return sendError(res, 400, 'VALIDATION_ERROR', '注文ステータスが不正です');
  }

  const existing = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 404, 'ORDER_NOT_FOUND', '注文が見つかりません');

  const explainerMatch =
    typeof explainerName === 'string' ? await matchExplainerName(prisma, explainerName) : null;

  const updated = await prisma.order.update({
    where: { id: req.params.id },
    data: {
      orderStatus: orderStatus ?? undefined,
      adminNote: typeof adminNote === 'string' ? adminNote : undefined,
      explainerName: typeof explainerName === 'string' ? explainerName.trim() || null : undefined,
      explainerAgencyId: explainerMatch ? explainerMatch.agencyId : undefined,
      explainerInfluencerId: explainerMatch ? explainerMatch.influencerId : undefined,
    },
  });

  res.json({ order: serializeOrder(updated) });
});

// 仕様書外の拡張: 銀行振込(手動確認型)の入金確認。決済確定に伴う在庫確定・NFT発行キュー作成・
// 報酬計算・購入完了メール送信は、Stripe決済完了時と同じ処理を共通関数で行う。
router.post('/orders/:id/confirm-bank-transfer', async (req, res) => {
  try {
    const result = await confirmBankTransferPayment(req.params.id);
    res.json({ order: serializeOrder(result.order) });
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

export default router;
