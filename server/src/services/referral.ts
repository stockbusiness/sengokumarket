import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export interface ResolvedReferral {
  referralCode: string | null;
  referrerName: string | null;
  agencyName: string | null;
  agencyId: string | null;
  influencerId: string | null;
  referralLinkId: string | null;
  commissionRate: number;
  // 仕様書外の拡張(クーポン機能): 紹介リンクに設定されたクーポン(発行時のみ設定可能。7章参照)。
  couponCode: string | null;
  couponAutoApply: boolean;
}

// 報酬率解決の優先順位(仕様書v1.5 6.13): referral_links.commission_rate → influencers.default → agencies.default → 0
export async function resolveReferral(tx: Tx, code: string | null | undefined): Promise<ResolvedReferral> {
  const empty: ResolvedReferral = {
    referralCode: code ?? null,
    referrerName: null,
    agencyName: null,
    agencyId: null,
    influencerId: null,
    referralLinkId: null,
    commissionRate: 0,
    couponCode: null,
    couponAutoApply: false,
  };

  if (!code) return empty;

  const link = await tx.referralLink.findFirst({
    where: { code, status: 'active' },
    include: { agency: true, influencer: true, coupon: true },
  });

  if (!link) return empty;

  const commissionRate = link.commissionRate?.toNumber() ?? link.influencer?.defaultCommissionRate?.toNumber() ?? link.agency?.defaultCommissionRate?.toNumber() ?? 0;

  return {
    referralCode: code,
    referrerName: link.influencer?.name ?? link.agency?.name ?? null,
    agencyName: link.agency?.name ?? null,
    agencyId: link.agencyId,
    influencerId: link.influencerId,
    referralLinkId: link.id,
    commissionRate,
    couponCode: link.coupon?.code ?? null,
    couponAutoApply: link.couponAutoApply,
  };
}

export interface StoredAttribution {
  agencyId: string | null;
  influencerId: string | null;
  referralLinkId: string | null;
  code: string | null;
}

// 仕様書外の拡張: ユーザーに永久帰属済みの代理店/インフルエンサーから、現在の報酬率を再解決する。
// 帰属先(agencyId/influencerId/referralLinkId)は初回購入時点で固定済みのため変更しない。
// リンクがinactive化されていても帰属は維持するため status フィルタは付けない。
export async function resolveReferralByAttribution(tx: Tx, attribution: StoredAttribution): Promise<ResolvedReferral> {
  const link = attribution.referralLinkId
    ? await tx.referralLink.findUnique({
        where: { id: attribution.referralLinkId },
        include: { agency: true, influencer: true, coupon: true },
      })
    : null;

  const agency = link?.agency ?? (attribution.agencyId ? await tx.agency.findUnique({ where: { id: attribution.agencyId } }) : null);
  const influencer =
    link?.influencer ?? (attribution.influencerId ? await tx.influencer.findUnique({ where: { id: attribution.influencerId } }) : null);

  const commissionRate = link?.commissionRate?.toNumber() ?? influencer?.defaultCommissionRate?.toNumber() ?? agency?.defaultCommissionRate?.toNumber() ?? 0;

  return {
    referralCode: attribution.code,
    referrerName: influencer?.name ?? agency?.name ?? null,
    agencyName: agency?.name ?? null,
    agencyId: attribution.agencyId,
    influencerId: attribution.influencerId,
    referralLinkId: attribution.referralLinkId,
    commissionRate,
    couponCode: link?.coupon?.code ?? null,
    couponAutoApply: link?.couponAutoApply ?? false,
  };
}
