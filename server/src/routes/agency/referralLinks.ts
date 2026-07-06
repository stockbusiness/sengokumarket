import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import {
  buildReferralUrl,
  createReferralLinkForAgency,
  resolveCommissionRate,
  type InfluencerInput,
} from '../../services/referralLinkService';

const router = Router();

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

router.get('/influencers', async (req, res) => {
  const agencyId = req.authUser!.agencyId!;
  const influencers = await prisma.influencer.findMany({
    where: { agencyId, status: 'active' },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  res.json({ influencers });
});

router.get('/referral-links/landing-options', async (_req, res) => {
  const products = await prisma.product.findMany({
    where: { status: 'published' },
    select: { slug: true, name: true },
  });
  res.json({ options: products.map((p) => ({ path: `/products/${p.slug}`, label: p.name })) });
});

router.get('/referral-links', async (req, res) => {
  const agencyId = req.authUser!.agencyId!;
  const links = await prisma.referralLink.findMany({
    where: { agencyId },
    include: { agency: true, influencer: true },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    referralLinks: links.map((link) => ({
      id: link.id,
      code: link.code,
      url: buildReferralUrl(link.landingPath, link.code),
      influencerName: link.influencer?.name ?? null,
      resolvedCommissionRate: resolveCommissionRate(
        link.commissionRate?.toNumber() ?? null,
        link.influencer?.defaultCommissionRate?.toNumber(),
        link.agency?.defaultCommissionRate?.toNumber() ?? 0,
      ),
      status: link.status,
      createdAt: link.createdAt,
    })),
  });
});

router.post('/referral-links', async (req, res) => {
  const agencyId = req.authUser!.agencyId!;
  const { influencer, commission_rate: commissionRate, landing_path: landingPathRaw } = req.body ?? {};

  const influencerInput = influencer as InfluencerInput | null | undefined;
  const landingPath = isNonEmptyString(landingPathRaw) ? landingPathRaw : '/products/council-nft';

  if (
    commissionRate !== null &&
    commissionRate !== undefined &&
    (typeof commissionRate !== 'number' || commissionRate < 0 || commissionRate > 100)
  ) {
    return sendError(res, 400, 'VALIDATION_ERROR', '報酬率は0〜100の数値で入力してください');
  }

  // 他代理店のインフルエンサーを指定できないようにする(代理店ポータルは自代理店の範囲に限定)。
  if (influencerInput?.id) {
    const target = await prisma.influencer.findUnique({ where: { id: influencerInput.id } });
    if (!target || target.agencyId !== agencyId) {
      return sendError(res, 404, 'INFLUENCER_NOT_FOUND', 'インフルエンサーが見つかりません');
    }
  }

  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  if (!agency) return sendError(res, 404, 'AGENCY_NOT_FOUND', '代理店が見つかりません');

  const { referralLink, influencerRecord } = await prisma.$transaction((tx) =>
    createReferralLinkForAgency(tx, agencyId, influencerInput, commissionRate ?? null, landingPath),
  );

  const resolvedRate = resolveCommissionRate(
    referralLink.commissionRate?.toNumber() ?? null,
    influencerRecord?.defaultCommissionRate?.toNumber(),
    agency.defaultCommissionRate.toNumber(),
  );

  res.status(201).json({
    referralLink: {
      id: referralLink.id,
      code: referralLink.code,
      url: buildReferralUrl(referralLink.landingPath, referralLink.code),
      influencerName: influencerRecord?.name ?? null,
      resolvedCommissionRate: resolvedRate,
      status: referralLink.status,
    },
  });
});

export default router;
