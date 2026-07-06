import { Router } from 'express';
import { prisma } from '../../lib/prisma';

const router = Router();

// 発行フォームのドロップダウン用(id / nameのみ。仕様書v1.5 13章)
router.get('/agencies', async (_req, res) => {
  const agencies = await prisma.agency.findMany({
    where: { status: 'active' },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  res.json({ agencies });
});

// 代理店ポータルログインの有無・ツリー構造(親代理店)を含めた一覧。管理画面での確認用(仕様書外の拡張)。
router.get('/agencies/detail', async (_req, res) => {
  const agencies = await prisma.agency.findMany({
    include: {
      parentAgency: { select: { name: true } },
      loginUsers: { select: { email: true }, where: { role: 'agency' } },
    },
    orderBy: { createdAt: 'asc' },
  });

  res.json({
    agencies: agencies.map((a) => ({
      id: a.id,
      name: a.name,
      code: a.code,
      externalId: a.externalId,
      parentAgencyName: a.parentAgency?.name ?? null,
      status: a.status,
      defaultCommissionRate: a.defaultCommissionRate.toNumber(),
      loginEmail: a.loginUsers[0]?.email ?? null,
    })),
  });
});

router.get('/influencers', async (req, res) => {
  const agencyId = typeof req.query.agency_id === 'string' ? req.query.agency_id : undefined;

  const influencers = await prisma.influencer.findMany({
    where: { status: 'active', agencyId: agencyId ?? null },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  res.json({ influencers });
});

export default router;
