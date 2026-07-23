import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

describe('管理API: 紹介リンク発行', () => {
  const marker = `reflinktest${Date.now()}`;

  afterAll(async () => {
    await prisma.referralLink.deleteMany({ where: { code: { startsWith: 'SGI' }, agency: { name: { contains: marker } } } });
    await prisma.influencer.deleteMany({ where: { name: { contains: marker } } });
    await prisma.agency.deleteMany({ where: { name: { contains: marker } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('代理店が未指定だと400を返す', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.post('/api/admin/referral-links').set('Origin', TEST_ORIGIN).send({ influencer: null });
    expect(res.status).toBe(400);
  });

  it('新規代理店・新規インフルエンサーをその場で作成しつつ紹介リンクを発行できる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .post('/api/admin/referral-links')
      .set('Origin', TEST_ORIGIN)
      .send({
        agency: { new_name: `${marker}代理店`, default_commission_rate: 25 },
        influencer: { new_name: `${marker}インフルエンサー` },
        commission_rate: null,
      });

    expect(res.status).toBe(201);
    expect(res.body.referralLink.code).toMatch(/^SGI\d{3,}$/);
    expect(res.body.referralLink.url).toContain(`ref=${res.body.referralLink.code}`);
    // 仕様書外の拡張(2026-07-22): 商品ごとの個別リンクではなく商品一覧ページへ統一する
    // (特定商品のslugが変更・非公開になっても既発行済みのリンクが壊れないようにするため)。
    expect(res.body.referralLink.url).toContain('/products?ref=');
    expect(res.body.referralLink.resolvedCommissionRate).toBe(25);
    expect(res.body.referralLink.status).toBe('active');

    const agency = await prisma.agency.findFirstOrThrow({ where: { name: `${marker}代理店` } });
    expect(agency.code).toMatch(/^AG\d{3,}$/);
    const influencer = await prisma.influencer.findFirstOrThrow({ where: { name: `${marker}インフルエンサー` } });
    expect(influencer.code).toMatch(/^INF\d{3,}$/);
    expect(influencer.agencyId).toBe(agency.id);
  });

  it('有効/無効を切り替えられる', async () => {
    const { agent } = await createAdminAgent(app);
    const link = await prisma.referralLink.findFirstOrThrow({ where: { agency: { name: { contains: marker } } } });

    const res = await agent
      .put(`/api/admin/referral-links/${link.id}/status`)
      .set('Origin', TEST_ORIGIN)
      .send({ status: 'inactive' });

    expect(res.status).toBe(200);
    expect(res.body.referralLink.status).toBe('inactive');
  });
});
