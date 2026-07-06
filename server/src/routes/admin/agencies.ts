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
