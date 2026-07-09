import type { Prisma } from '@prisma/client';
import { generateInfluencerCode, generateReferralLinkCode } from './referralCodeGenerator';

type Tx = Prisma.TransactionClient;

export interface InfluencerInput {
  id?: string;
  new_name?: string;
}

export function buildReferralUrl(landingPath: string, code: string): string {
  const appUrl = process.env.APP_URL ?? '';
  const separator = landingPath.includes('?') ? '&' : '?';
  return `${appUrl}${landingPath}${separator}ref=${code}`;
}

export function resolveCommissionRate(
  linkRate: number | null,
  influencerRate: number | null | undefined,
  agencyRate: number,
): number {
  if (linkRate !== null && linkRate !== undefined) return linkRate;
  if (influencerRate !== null && influencerRate !== undefined) return influencerRate;
  return agencyRate;
}

// 指定した代理店に紐づくインフルエンサー(新規 or 既存選択)と紹介リンクを作成する。
// admin用・代理店ポータル用の両方から共通で利用する。
// 仕様書外の拡張(クーポン機能): 紹介リンクの編集・削除機能は作らない方針(CLAUDE.md)のため、
// クーポンの紐づけは発行時のみ指定できる。
export async function createReferralLinkForAgency(
  tx: Tx,
  agencyId: string,
  influencerInput: InfluencerInput | null | undefined,
  commissionRate: number | null,
  landingPath: string,
  couponId: string | null = null,
  couponAutoApply = true,
) {
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
    data: { code: linkCode, agencyId, influencerId, commissionRate, landingPath, couponId, couponAutoApply },
  });

  return { referralLink, influencerRecord };
}
