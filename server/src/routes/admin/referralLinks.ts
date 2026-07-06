import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { generateAgencyCode, generateInfluencerCode, generateReferralLinkCode } from '../../services/referralCodeGenerator';

const router = Router();

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function buildReferralUrl(landingPath: string, code: string): string {
  const appUrl = process.env.APP_URL ?? '';
  const separator = landingPath.includes('?') ? '&' : '?';
  return `${appUrl}${landingPath}${separator}ref=${code}`;
}

function resolveRate(
  linkRate: number | null,
  influencerRate: number | null | undefined,
  agencyRate: number,
): number {
  if (linkRate !== null && linkRate !== undefined) return linkRate;
  if (influencerRate !== null && influencerRate !== undefined) return influencerRate;
  return agencyRate;
}

router.get('/referral-links', async (_req, res) => {
  const links = await prisma.referralLink.findMany({
    include: { agency: true, influencer: true },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    referralLinks: links.map((link) => {
      const rate = resolveRate(
        link.commissionRate?.toNumber() ?? null,
        link.influencer?.defaultCommissionRate?.toNumber(),
        link.agency?.defaultCommissionRate?.toNumber() ?? 0,
      );
      return {
        id: link.id,
        code: link.code,
        url: buildReferralUrl(link.landingPath, link.code),
        agencyName: link.agency?.name ?? null,
        influencerName: link.influencer?.name ?? null,
        resolvedCommissionRate: rate,
        status: link.status,
        createdAt: link.createdAt,
      };
    }),
  });
});

router.get('/referral-links/landing-options', async (_req, res) => {
  const products = await prisma.product.findMany({
    where: { status: 'published' },
    select: { slug: true, name: true },
  });
  res.json({ options: products.map((p) => ({ path: `/products/${p.slug}`, label: p.name })) });
});

interface AgencyInput {
  id?: string;
  new_name?: string;
  default_commission_rate?: number;
}
interface InfluencerInput {
  id?: string;
  new_name?: string;
}

router.post('/referral-links', async (req, res) => {
  const { agency, influencer, commission_rate: commissionRate, landing_path: landingPathRaw } = req.body ?? {};

  const agencyInput = agency as AgencyInput | undefined;
  if (!agencyInput || (!isNonEmptyString(agencyInput.id) && !isNonEmptyString(agencyInput.new_name))) {
    return sendError(res, 400, 'VALIDATION_ERROR', '代理店を選択するか新規名称を入力してください');
  }

  const influencerInput = influencer as InfluencerInput | null | undefined;
  const landingPath = isNonEmptyString(landingPathRaw) ? landingPathRaw : '/products/council-nft';

  if (
    commissionRate !== null &&
    commissionRate !== undefined &&
    (typeof commissionRate !== 'number' || commissionRate < 0 || commissionRate > 100)
  ) {
    return sendError(res, 400, 'VALIDATION_ERROR', '報酬率は0〜100の数値で入力してください');
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      let agencyId: string;
      let agencyRecord;
      if (agencyInput.id) {
        agencyRecord = await tx.agency.findUnique({ where: { id: agencyInput.id } });
        if (!agencyRecord) throw new Error('AGENCY_NOT_FOUND');
        agencyId = agencyRecord.id;
      } else {
        const code = await generateAgencyCode(tx);
        agencyRecord = await tx.agency.create({
          data: {
            name: agencyInput.new_name!.trim(),
            code,
            defaultCommissionRate: agencyInput.default_commission_rate ?? 0,
          },
        });
        agencyId = agencyRecord.id;
      }

      let influencerId: string | null = null;
      let influencerRecord = null;
      if (influencerInput?.id) {
        influencerRecord = await tx.influencer.findUnique({ where: { id: influencerInput.id } });
        if (!influencerRecord) throw new Error('INFLUENCER_NOT_FOUND');
        influencerId = influencerRecord.id;
      } else if (influencerInput?.new_name) {
        const code = await generateInfluencerCode(tx);
        influencerRecord = await tx.influencer.create({
          data: { agencyId, name: influencerInput.new_name.trim(), code },
        });
        influencerId = influencerRecord.id;
      }

      const linkCode = await generateReferralLinkCode(tx);
      const referralLink = await tx.referralLink.create({
        data: {
          code: linkCode,
          agencyId,
          influencerId,
          commissionRate: commissionRate ?? null,
          landingPath,
        },
      });

      return { referralLink, agencyRecord, influencerRecord };
    });

    const resolvedRate = resolveRate(
      result.referralLink.commissionRate?.toNumber() ?? null,
      result.influencerRecord?.defaultCommissionRate?.toNumber(),
      result.agencyRecord.defaultCommissionRate.toNumber(),
    );

    res.status(201).json({
      referralLink: {
        id: result.referralLink.id,
        code: result.referralLink.code,
        url: buildReferralUrl(result.referralLink.landingPath, result.referralLink.code),
        agencyName: result.agencyRecord.name,
        influencerName: result.influencerRecord?.name ?? null,
        resolvedCommissionRate: resolvedRate,
        status: result.referralLink.status,
      },
    });
  } catch (e) {
    if (e instanceof Error && e.message === 'AGENCY_NOT_FOUND') {
      return sendError(res, 404, 'AGENCY_NOT_FOUND', '代理店が見つかりません');
    }
    if (e instanceof Error && e.message === 'INFLUENCER_NOT_FOUND') {
      return sendError(res, 404, 'INFLUENCER_NOT_FOUND', 'インフルエンサーが見つかりません');
    }
    throw e;
  }
});

// 有効/無効の切替のみ。編集・削除機能は作らない(仕様書v1.5 5.9)。
router.put('/referral-links/:id/status', async (req, res) => {
  const { status } = req.body ?? {};
  if (status !== 'active' && status !== 'inactive') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'statusはactiveまたはinactiveを指定してください');
  }

  const existing = await prisma.referralLink.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 404, 'REFERRAL_LINK_NOT_FOUND', '紹介リンクが見つかりません');

  const updated = await prisma.referralLink.update({ where: { id: req.params.id }, data: { status } });
  res.json({ referralLink: { id: updated.id, status: updated.status } });
});

export default router;
