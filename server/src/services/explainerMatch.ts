import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export interface ExplainerMatch {
  agencyId: string | null;
  influencerId: string | null;
}

const NO_MATCH: ExplainerMatch = { agencyId: null, influencerId: null };

// 仕様書外の拡張: チェックアウト時に自由入力される「説明責任者」の名前を、既存の代理店
// (エージェント/ディレクター)・インフルエンサー(アドバイザー)の名簿と突き合わせる。
// 一致がちょうど1件の場合のみIDを記録する。0件(未登録)または複数件(同姓同名等で曖昧)の
// 場合はIDを付けず名前だけ保存する — この照合はあくまで参照用の紐付けであり、購入自体や
// 報酬計算を一切ブロック/変更しない。
export async function matchExplainerName(tx: Tx, rawName: string | null | undefined): Promise<ExplainerMatch> {
  const name = rawName?.trim();
  if (!name) return NO_MATCH;

  const [agencies, influencers] = await Promise.all([
    tx.agency.findMany({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } }),
    tx.influencer.findMany({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } }),
  ]);

  const totalMatches = agencies.length + influencers.length;
  if (totalMatches !== 1) return NO_MATCH;

  if (agencies.length === 1) return { agencyId: agencies[0].id, influencerId: null };
  return { agencyId: null, influencerId: influencers[0].id };
}
