import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

// AG/INF/SGIの連番はseedデータ(AG001/INF001/SGI001)の続きから自動採番する(仕様書v1.5 10章)。
// 日付単位ではなくprefix単位のアドバイザリロックで直列化する。
async function generateSequentialCode(tx: Tx, prefix: string, count: () => Promise<number>): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`;
  const current = await count();
  return `${prefix}${String(current + 1).padStart(3, '0')}`;
}

export function generateAgencyCode(tx: Tx): Promise<string> {
  return generateSequentialCode(tx, 'AG', () => tx.agency.count());
}

export function generateInfluencerCode(tx: Tx): Promise<string> {
  return generateSequentialCode(tx, 'INF', () => tx.influencer.count());
}

export function generateReferralLinkCode(tx: Tx): Promise<string> {
  return generateSequentialCode(tx, 'SGI', () => tx.referralLink.count());
}
