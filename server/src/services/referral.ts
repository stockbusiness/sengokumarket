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
  };

  if (!code) return empty;

  const link = await tx.referralLink.findFirst({
    where: { code, status: 'active' },
    include: { agency: true, influencer: true },
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
  };
}
