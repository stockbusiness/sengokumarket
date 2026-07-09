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

// 仕様書外の拡張(クーポン機能): 発行時に選択できる、この代理店が利用可能なクーポンの一覧。
router.get('/coupons/available', async (req, res) => {
  const agencyId = req.authUser!.agencyId!;
  const now = new Date();

  const coupons = await prisma.coupon.findMany({
    where: {
      deletedAt: null,
      isActive: true,
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
  });

  const eligible = [];
  for (const coupon of coupons) {
    if (coupon.agencyScopeType === 'include') {
      const entry = await prisma.couponAgency.findUnique({ where: { couponId_agencyId: { couponId: coupon.id, agencyId } } });
      if (!entry) continue;
    }
    if (coupon.totalUsageLimit !== null && coupon.usedCount + coupon.reservedCount >= coupon.totalUsageLimit) continue;

    eligible.push({
      id: coupon.id,
      code: coupon.code,
      name: coupon.name,
      discountType: coupon.discountType,
      discountAmount: coupon.discountAmount,
      discountPercentage: coupon.discountPercentage?.toNumber() ?? null,
      expiresAt: coupon.expiresAt,
    });
  }

  res.json({ coupons: eligible });
});

router.get('/referral-links', async (req, res) => {
  const agencyId = req.authUser!.agencyId!;
  const links = await prisma.referralLink.findMany({
    where: { agencyId },
    include: { agency: true, influencer: true, coupon: true },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    referralLinks: links.map((link) => ({
      id: link.id,
      code: link.code,
      url: buildReferralUrl(link.landingPath, link.code),
      influencerName: link.influencer?.name ?? null,
      couponName: link.coupon?.name ?? null,
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
  const {
    influencer,
    commission_rate: commissionRate,
    landing_path: landingPathRaw,
    coupon_id: couponId,
    coupon_auto_apply: couponAutoApplyRaw,
  } = req.body ?? {};

  const influencerInput = influencer as InfluencerInput | null | undefined;
  const landingPath = isNonEmptyString(landingPathRaw) ? landingPathRaw : '/products/council-nft';
  const couponAutoApply = couponAutoApplyRaw !== false;

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

  // 仕様書外の拡張(クーポン機能): この代理店が実際に利用可能なクーポンかをサーバー側で検証する
  // (クライアントの一覧表示を信用しない。仕様書2.3)。
  let validatedCouponId: string | null = null;
  if (isNonEmptyString(couponId)) {
    const coupon = await prisma.coupon.findUnique({ where: { id: couponId } });
    if (!coupon || coupon.deletedAt || !coupon.isActive) {
      return sendError(res, 404, 'COUPON_NOT_FOUND', 'クーポンが見つかりません');
    }
    if (coupon.agencyScopeType === 'include') {
      const entry = await prisma.couponAgency.findUnique({ where: { couponId_agencyId: { couponId: coupon.id, agencyId } } });
      if (!entry) return sendError(res, 403, 'COUPON_NOT_ELIGIBLE', 'この代理店はこのクーポンを利用できません');
    }
    validatedCouponId = coupon.id;
  }

  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  if (!agency) return sendError(res, 404, 'AGENCY_NOT_FOUND', '代理店が見つかりません');

  const { referralLink, influencerRecord } = await prisma.$transaction((tx) =>
    createReferralLinkForAgency(tx, agencyId, influencerInput, commissionRate ?? null, landingPath, validatedCouponId, couponAutoApply),
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
      couponId: referralLink.couponId,
      resolvedCommissionRate: resolvedRate,
      status: referralLink.status,
    },
  });
});

export default router;
