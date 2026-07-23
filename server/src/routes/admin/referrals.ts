import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { buildCsv } from '../../lib/csv';
import { COMMISSION_STATUSES, type CommissionStatus } from '@sengoku/contracts';
import { assertCommissionTransition } from '../../shared/statusPolicy/commissionStatus.policy';
import { DomainError } from '../../shared/errors/domainError';
import { parsePagination } from '../../shared/pagination/parsePagination';

const router = Router();

router.get('/referrals/summary', async (_req, res) => {
  const paidOrders = await prisma.order.findMany({
    where: { paymentStatus: 'paid', OR: [{ agencyId: { not: null } }, { influencerId: { not: null } }] },
    select: { agencyId: true, influencerId: true, totalAmount: true, commissionAmount: true },
  });
  const allReferralOrders = await prisma.order.findMany({
    where: { OR: [{ agencyId: { not: null } }, { influencerId: { not: null } }] },
    select: { agencyId: true, influencerId: true, paymentStatus: true },
  });

  const agencies = await prisma.agency.findMany();
  const influencers = await prisma.influencer.findMany();

  const byAgency = agencies.map((agency) => {
    const paid = paidOrders.filter((o) => o.agencyId === agency.id);
    const all = allReferralOrders.filter((o) => o.agencyId === agency.id);
    return {
      agencyId: agency.id,
      agencyName: agency.name,
      orderCount: all.length,
      paidCount: paid.length,
      salesAmount: paid.reduce((sum, o) => sum + o.totalAmount, 0),
      commissionAmount: paid.reduce((sum, o) => sum + o.commissionAmount, 0),
    };
  });

  const byInfluencer = influencers.map((influencer) => {
    const paid = paidOrders.filter((o) => o.influencerId === influencer.id);
    const all = allReferralOrders.filter((o) => o.influencerId === influencer.id);
    const agency = agencies.find((a) => a.id === influencer.agencyId);
    return {
      influencerId: influencer.id,
      influencerName: influencer.name,
      agencyName: agency?.name ?? null,
      orderCount: all.length,
      paidCount: paid.length,
      salesAmount: paid.reduce((sum, o) => sum + o.totalAmount, 0),
      commissionAmount: paid.reduce((sum, o) => sum + o.commissionAmount, 0),
    };
  });

  res.json({ byAgency, byInfluencer });
});

router.get('/referrals/orders', async (req, res) => {
  const agencyId = typeof req.query.agency_id === 'string' ? req.query.agency_id : undefined;
  const influencerId = typeof req.query.influencer_id === 'string' ? req.query.influencer_id : undefined;

  const orders = await prisma.order.findMany({
    where: {
      OR: [{ agencyId: { not: null } }, { influencerId: { not: null } }],
      agencyId: agencyId ?? undefined,
      influencerId: influencerId ?? undefined,
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    orders: orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      customerName: o.customerName,
      totalAmount: o.totalAmount,
      paymentStatus: o.paymentStatus,
      referralCode: o.referralCode,
      agencyName: o.agencyName,
      referrerName: o.referrerName,
      commissionRate: o.commissionRate,
      commissionAmount: o.commissionAmount,
      commissionStatus: o.commissionStatus,
      createdAt: o.createdAt,
    })),
  });
});

router.get('/referrals/commissions', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const { page, pageSize, skip, take } = parsePagination(req.query);

  const where = status ? { status } : undefined;
  const [commissions, total] = await Promise.all([
    prisma.commission.findMany({
      where,
      include: { order: true, agency: true, influencer: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.commission.count({ where }),
  ]);

  res.json({
    commissions: commissions.map((c) => ({
      id: c.id,
      orderNumber: c.order.orderNumber,
      customerName: c.order.customerName,
      agencyName: c.agency?.name ?? null,
      influencerName: c.influencer?.name ?? null,
      referralCode: c.referralCode,
      baseAmount: c.baseAmount,
      commissionRate: c.commissionRate,
      commissionAmount: c.commissionAmount,
      status: c.status,
      approvedAt: c.approvedAt,
      paidAt: c.paidAt,
      adminNote: c.adminNote,
    })),
    total,
    page,
    pageSize,
  });
});

// commissionsが報酬データの正。更新時は同一トランザクションでordersのキャッシュを同期する(仕様書v1.5 5.8 / 6.14)。
router.put('/referrals/commissions/:id', async (req, res) => {
  const { status, adminNote } = req.body ?? {};

  if (status !== undefined && !COMMISSION_STATUSES.includes(status)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ステータスが不正です');
  }

  const existing = await prisma.commission.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 404, 'COMMISSION_NOT_FOUND', '報酬データが見つかりません');

  if (status !== undefined) {
    try {
      assertCommissionTransition(existing.status as CommissionStatus, status);
    } catch (e) {
      if (e instanceof DomainError) return sendError(res, 409, e.code, e.message);
      throw e;
    }
  }

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const commission = await tx.commission.update({
      where: { id: req.params.id },
      data: {
        status: status ?? undefined,
        adminNote: typeof adminNote === 'string' ? adminNote : undefined,
        approvedAt: status === 'approved' && !existing.approvedAt ? now : undefined,
        paidAt: status === 'paid' && !existing.paidAt ? now : undefined,
      },
    });

    await tx.order.update({
      where: { id: commission.orderId },
      data: {
        commissionStatus: status ?? undefined,
        commissionAmount: commission.commissionAmount,
      },
    });

    return commission;
  });

  res.json({ commission: updated });
});

router.get('/referrals/export.csv', async (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  const markApproved = req.query.mark_approved === 'true';

  if (!from || !to) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'from/toを指定してください');
  }

  const requestedStatuses = typeof req.query.status === 'string' ? req.query.status.split(',') : ['pending', 'approved'];
  // cancelledは常に対象外。paidはデフォルト除外でオプションのみ含められる(仕様書v1.5 9.7)。
  const statuses = requestedStatuses.filter((s) => (COMMISSION_STATUSES as readonly string[]).includes(s) && s !== 'cancelled');

  const toDateExclusive = new Date(to);
  toDateExclusive.setDate(toDateExclusive.getDate() + 1);

  const commissions = await prisma.commission.findMany({
    where: {
      status: { in: statuses },
      order: {
        paymentStatus: 'paid',
        paidAt: { gte: new Date(from), lt: toDateExclusive },
      },
    },
    include: { order: { include: { orderItems: true } }, agency: true, influencer: true },
    orderBy: { order: { paidAt: 'asc' } },
  });

  const rows = commissions.map((c) => {
    const payeeType = c.agencyId ? 'agency' : 'influencer';
    const payeeName = c.agency?.name ?? c.influencer?.name ?? '';
    return [
      c.order.orderNumber,
      c.order.createdAt.toISOString(),
      c.order.paidAt?.toISOString() ?? '',
      c.order.customerName,
      c.order.customerEmail,
      c.order.orderItems.map((i) => i.productName).join('/'),
      c.order.totalAmount,
      c.referralCode ?? '',
      payeeType,
      payeeName,
      c.agency?.name ?? '',
      c.influencer?.name ?? '',
      c.commissionRate.toString(),
      c.commissionAmount,
      c.status,
      c.order.stripePaymentIntentId ?? '',
    ];
  });

  const csv = buildCsv(
    [
      '注文番号',
      '注文日',
      '決済日',
      '購入者名',
      '購入者メール',
      '商品名',
      '購入金額',
      '紹介コード',
      '支払先区分',
      '支払先名',
      '代理店名',
      'インフルエンサー名',
      '報酬率',
      '報酬予定額',
      '報酬ステータス',
      'Stripe Payment Intent ID',
    ],
    rows,
  );

  if (markApproved) {
    const pendingIds = commissions.filter((c) => c.status === 'pending').map((c) => c.id);
    if (pendingIds.length > 0) {
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        for (const id of pendingIds) {
          const commission = await tx.commission.update({
            where: { id },
            data: { status: 'approved', approvedAt: now },
          });
          await tx.order.update({
            where: { id: commission.orderId },
            data: { commissionStatus: 'approved' },
          });
        }
      });
    }
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="commissions_${from}_${to}.csv"`);
  res.send(csv);
});

export default router;
