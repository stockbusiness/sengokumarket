import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { matchExplainerName } from './explainerMatch';

describe('matchExplainerName(仕様書外の拡張)', () => {
  const createdAgencyIds: string[] = [];
  const createdInfluencerIds: string[] = [];

  afterAll(async () => {
    await prisma.influencer.deleteMany({ where: { id: { in: createdInfluencerIds } } });
    await prisma.agency.deleteMany({ where: { id: { in: createdAgencyIds } } });
    await prisma.$disconnect();
  });

  it('名前が空/未入力の場合はどちらも一致させない', async () => {
    expect(await matchExplainerName(prisma, null)).toEqual({ agencyId: null, influencerId: null });
    expect(await matchExplainerName(prisma, undefined)).toEqual({ agencyId: null, influencerId: null });
    expect(await matchExplainerName(prisma, '   ')).toEqual({ agencyId: null, influencerId: null });
  });

  it('名簿に存在しない名前は一致させず、名前だけ保存できる想定(ID無し)', async () => {
    const result = await matchExplainerName(prisma, `存在しない説明担当者-${Date.now()}`);
    expect(result).toEqual({ agencyId: null, influencerId: null });
  });

  it('代理店名と完全一致(大文字小文字を無視)がちょうど1件ならagencyIdを返す', async () => {
    const name = `説明照合テスト代理店-${Date.now()}`;
    const agency = await prisma.agency.create({ data: { name, code: `EXPMATCH-AG-${Date.now()}` } });
    createdAgencyIds.push(agency.id);

    const result = await matchExplainerName(prisma, name.toUpperCase());
    expect(result).toEqual({ agencyId: agency.id, influencerId: null });
  });

  it('インフルエンサー名と完全一致がちょうど1件ならinfluencerIdを返す', async () => {
    const name = `説明照合テストアドバイザー-${Date.now()}`;
    const influencer = await prisma.influencer.create({ data: { name, code: `EXPMATCH-INF-${Date.now()}` } });
    createdInfluencerIds.push(influencer.id);

    const result = await matchExplainerName(prisma, name);
    expect(result).toEqual({ agencyId: null, influencerId: influencer.id });
  });

  it('同姓同名などで代理店・インフルエンサー合わせて複数件一致する場合はどちらも一致させない(曖昧)', async () => {
    const name = `説明照合曖昧テスト-${Date.now()}`;
    const agency = await prisma.agency.create({ data: { name, code: `EXPMATCH-AMBIG-AG-${Date.now()}` } });
    createdAgencyIds.push(agency.id);
    const influencer = await prisma.influencer.create({ data: { name, code: `EXPMATCH-AMBIG-INF-${Date.now()}` } });
    createdInfluencerIds.push(influencer.id);

    const result = await matchExplainerName(prisma, name);
    expect(result).toEqual({ agencyId: null, influencerId: null });
  });
});
