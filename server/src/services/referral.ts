import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

// 仕様書外の拡張: 代理店階層(エージェント/ディレクター)の紐付けを記録目的でスナップショット
// するための型。depth 0が直属の親、値が大きいほど上位。報酬計算には一切使わない。
export interface AgencyHierarchyNode {
  id: string;
  name: string;
  code: string;
  depth: number;
}

const MAX_AGENCY_HIERARCHY_DEPTH = 20;

// agencyIdから上に辿って祖先を取得する(記録のみ目的。報酬計算には使わない)。
// includeSelf=falseの場合、agencyId自身は含めず親(parentAgencyId)から辿る
// (紹介リンクに直接紐付いた代理店の場合。既存のOrder.agencyId/agencyNameで記録済みのため)。
// includeSelf=trueの場合、agencyId自身をdepth 0として含める
// (アドバイザー(インフルエンサー)経由の紹介で、そのアドバイザーの直属代理店(ディレクター相当)は
// Orderのどのカラムにも記録されないため、この関数の呼び出し側で明示的に含める必要がある場合)。
// 循環データが万一存在しても無限ループしないよう深さに上限を設ける。
export async function resolveAgencyHierarchyChain(
  tx: Tx,
  agencyId: string | null,
  includeSelf = false,
): Promise<AgencyHierarchyNode[]> {
  const chain: AgencyHierarchyNode[] = [];
  if (!agencyId) return chain;

  let currentId: string | null = agencyId;
  if (!includeSelf) {
    const start = await tx.agency.findUnique({ where: { id: agencyId }, select: { parentAgencyId: true } });
    currentId = start?.parentAgencyId ?? null;
  }

  let depth = 0;
  while (currentId && depth < MAX_AGENCY_HIERARCHY_DEPTH) {
    const agency = await tx.agency.findUnique({
      where: { id: currentId },
      select: { id: true, name: true, code: true, parentAgencyId: true },
    });
    if (!agency) break;
    chain.push({ id: agency.id, name: agency.name, code: agency.code, depth });
    currentId = agency.parentAgencyId;
    depth += 1;
  }
  return chain;
}

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
  // 仕様書外の拡張: agencyIdの祖先チェーン(ディレクター・エージェント)。報酬計算には使わない。
  agencyHierarchy: AgencyHierarchyNode[];
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
    agencyHierarchy: [],
  };

  if (!code) return empty;

  const link = await tx.referralLink.findFirst({
    where: { code, status: 'active' },
    include: { agency: true, influencer: true, coupon: true },
  });

  if (!link) return empty;

  const commissionRate = link.commissionRate?.toNumber() ?? link.influencer?.defaultCommissionRate?.toNumber() ?? link.agency?.defaultCommissionRate?.toNumber() ?? 0;
  const baseAgencyId = link.agencyId ?? link.influencer?.agencyId ?? null;
  // link.agencyIdが直接紐付いている場合はOrder.agencyIdとして既に記録されるため自身は含めない。
  // アドバイザー(インフルエンサー)経由のみの場合、その直属代理店はOrderのどこにも記録されないため含める。
  const includeSelfInHierarchy = !link.agencyId;

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
    agencyHierarchy: await resolveAgencyHierarchyChain(tx, baseAgencyId, includeSelfInHierarchy),
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
  const baseAgencyId = attribution.agencyId ?? influencer?.agencyId ?? null;
  // attribution.agencyIdが直接紐付いている場合はOrder.agencyIdとして既に記録されるため自身は含めない。
  // アドバイザー(インフルエンサー)経由のみの場合、その直属代理店はOrderのどこにも記録されないため含める。
  const includeSelfInHierarchy = !attribution.agencyId;

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
    agencyHierarchy: await resolveAgencyHierarchyChain(tx, baseAgencyId, includeSelfInHierarchy),
  };
}
