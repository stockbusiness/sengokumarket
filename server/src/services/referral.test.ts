import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { resolveAgencyHierarchyChain, resolveReferral } from './referral';

describe('resolveAgencyHierarchyChain(仕様書外の拡張)', () => {
  const createdAgencyIds: string[] = [];

  afterAll(async () => {
    await prisma.agency.deleteMany({ where: { id: { in: createdAgencyIds } } });
    await prisma.$disconnect();
  });

  async function createAgency(name: string, parentAgencyId: string | null) {
    const agency = await prisma.agency.create({
      data: { name, code: `HIER-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`, parentAgencyId },
    });
    createdAgencyIds.push(agency.id);
    return agency;
  }

  it('祖先が無い場合は空配列を返す', async () => {
    const agency = await createAgency('祖先なし代理店', null);
    const chain = await resolveAgencyHierarchyChain(prisma, agency.id);
    expect(chain).toEqual([]);
  });

  it('agencyIdがnullの場合は空配列を返す', async () => {
    const chain = await resolveAgencyHierarchyChain(prisma, null);
    expect(chain).toEqual([]);
  });

  it('1階層の祖先(ディレクター→エージェント)を depth 0 で返す', async () => {
    const topAgency = await createAgency('1階層エージェント', null);
    const director = await createAgency('1階層ディレクター', topAgency.id);

    const chain = await resolveAgencyHierarchyChain(prisma, director.id);
    expect(chain).toEqual([{ id: topAgency.id, name: topAgency.name, code: topAgency.code, depth: 0 }]);
  });

  it('3階層以上の祖先を depth の昇順(直属が0、上位ほど大きい)で返す', async () => {
    const top = await createAgency('3階層エージェント', null);
    const mid = await createAgency('3階層ディレクター', top.id);
    const advisorAgency = await createAgency('3階層アドバイザー相当代理店', mid.id);

    const chain = await resolveAgencyHierarchyChain(prisma, advisorAgency.id);
    expect(chain).toEqual([
      { id: mid.id, name: mid.name, code: mid.code, depth: 0 },
      { id: top.id, name: top.name, code: top.code, depth: 1 },
    ]);
  });

  it('includeSelf=trueの場合、指定したagencyId自身をdepth 0として含める', async () => {
    const top = await createAgency('includeSelfエージェント', null);
    const mid = await createAgency('includeSelfディレクター', top.id);

    const chain = await resolveAgencyHierarchyChain(prisma, mid.id, true);
    expect(chain).toEqual([
      { id: mid.id, name: mid.name, code: mid.code, depth: 0 },
      { id: top.id, name: top.name, code: top.code, depth: 1 },
    ]);
  });
});

describe('resolveReferral の agencyHierarchy(仕様書外の拡張)', () => {
  const createdAgencyIds: string[] = [];
  let referralLinkId: string;

  afterAll(async () => {
    await prisma.referralLink.deleteMany({ where: { id: referralLinkId } });
    await prisma.influencer.deleteMany({ where: { agencyId: { in: createdAgencyIds } } });
    await prisma.agency.deleteMany({ where: { id: { in: createdAgencyIds } } });
    await prisma.$disconnect();
  });

  it('アドバイザー(インフルエンサー)経由の紹介コードで、直属エージェントの祖先チェーンが解決される', async () => {
    const topAgency = await prisma.agency.create({
      data: { name: '紹介テストエージェント', code: `REFHIER-TOP-${Date.now()}`, defaultCommissionRate: 10 },
    });
    createdAgencyIds.push(topAgency.id);
    const directorAgency = await prisma.agency.create({
      data: { name: '紹介テストディレクター', code: `REFHIER-DIR-${Date.now()}`, parentAgencyId: topAgency.id, defaultCommissionRate: 10 },
    });
    createdAgencyIds.push(directorAgency.id);
    const advisor = await prisma.influencer.create({
      data: { agencyId: directorAgency.id, name: '紹介テストアドバイザー', code: `REFHIER-ADV-${Date.now()}` },
    });

    const link = await prisma.referralLink.create({
      data: { code: `REFHIERLINK-${Date.now()}`.slice(0, 20), influencerId: advisor.id, landingPath: '/products/test' },
    });
    referralLinkId = link.id;

    const resolved = await resolveReferral(prisma, link.code);
    expect(resolved.agencyId).toBeNull();
    expect(resolved.influencerId).toBe(advisor.id);
    expect(resolved.agencyHierarchy).toEqual([{ id: directorAgency.id, name: directorAgency.name, code: directorAgency.code, depth: 0 }, { id: topAgency.id, name: topAgency.name, code: topAgency.code, depth: 1 }]);
  });

  it('紹介コードが無い場合はagencyHierarchyが空配列', async () => {
    const resolved = await resolveReferral(prisma, null);
    expect(resolved.agencyHierarchy).toEqual([]);
  });

  it('代理店に直接紐付いた紹介コードの場合、その代理店自身はOrder.agencyIdで既に記録されるためagencyHierarchyには含めず、さらに上位のみを返す', async () => {
    const topAgency = await prisma.agency.create({
      data: { name: '直接リンクテストエージェント', code: `REFHIER-DIRECTTOP-${Date.now()}`, defaultCommissionRate: 10 },
    });
    createdAgencyIds.push(topAgency.id);
    const directAgency = await prisma.agency.create({
      data: { name: '直接リンクテストディレクター', code: `REFHIER-DIRECTMID-${Date.now()}`, parentAgencyId: topAgency.id, defaultCommissionRate: 10 },
    });
    createdAgencyIds.push(directAgency.id);

    const link = await prisma.referralLink.create({
      data: { code: `REFHIERDIRECTLINK-${Date.now()}`.slice(0, 20), agencyId: directAgency.id, landingPath: '/products/test' },
    });

    const resolved = await resolveReferral(prisma, link.code);
    expect(resolved.agencyId).toBe(directAgency.id);
    expect(resolved.agencyHierarchy).toEqual([{ id: topAgency.id, name: topAgency.name, code: topAgency.code, depth: 0 }]);

    await prisma.referralLink.delete({ where: { id: link.id } });
  });
});
