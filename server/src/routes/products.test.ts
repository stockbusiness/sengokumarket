import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';
import { referralCookieHeader } from '../test/referralCookie';
import { TEST_ORIGIN } from '../test/adminAgent';

const app = createApp();

// このカートは一般公開せず、代理店の紹介URL経由でのみ利用する運用のため、
// 紹介URL(Cookie)を踏んでいない・ログインもしていないブラウザには商品情報を見せない。
describe('公開API: 商品(紹介URL/ログイン必須のアクセス制御)', () => {
  let productSlug: string;
  let agencyId: string;

  beforeAll(async () => {
    const product = await prisma.product.create({
      data: {
        name: 'テスト商品(アクセス制御)',
        slug: `test-referralgate-product-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 1000,
        status: 'published',
      },
    });
    productSlug = product.slug;

    // 仕様書外の拡張(2026-07-22指示書対応): ?ref=クエリはreferral_links.codeとして実在し、
    // status='active'であることをDBで検証するようになったため、実データを用意する。
    const agency = await prisma.agency.create({
      data: { name: '商品アクセス制御テスト代理店', code: `PRODTEST-AG-${Date.now()}`, defaultCommissionRate: 10 },
    });
    agencyId = agency.id;
    await prisma.referralLink.create({ data: { code: 'TEST-REF', agencyId, status: 'active' } });
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { slug: productSlug } });
    await prisma.user.deleteMany({ where: { email: { contains: 'referralgate-test' } } });
    await prisma.referralLink.deleteMany({ where: { agencyId } });
    await prisma.agency.deleteMany({ where: { id: agencyId } });
    await prisma.$disconnect();
  });

  it('紹介Cookieもログインもない場合は403 REFERRAL_REQUIRED', async () => {
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REFERRAL_REQUIRED');
  });

  it('商品詳細も同様に403になる', async () => {
    const res = await request(app).get(`/api/products/${productSlug}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REFERRAL_REQUIRED');
  });

  it('有効な紹介Cookieがあれば200で取得できる', async () => {
    const res = await request(app).get('/api/products').set('Cookie', referralCookieHeader());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.products)).toBe(true);
  });

  it('期限切れの紹介Cookieは403のまま', async () => {
    const expiredPayload = {
      referral_code: 'EXPIRED-REF',
      source: 'url',
      saved_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      expires_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const cookie = `sengoku_referral=${encodeURIComponent(JSON.stringify(expiredPayload))}`;

    const res = await request(app).get('/api/products').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REFERRAL_REQUIRED');
  });

  it('紹介Cookieがなくてもログイン済みなら200で取得できる', async () => {
    const email = `referralgate-test-${Date.now()}@example.com`;
    const agent = request.agent(app);
    await agent
      .post('/api/auth/register')
      .set('Origin', TEST_ORIGIN)
      .send({ name: 'テスト', email, password: 'password123' });

    const res = await agent.get('/api/products');
    expect(res.status).toBe(200);
  });

  describe('クエリパラメータrefによるフォールバック(仕様書外の拡張)', () => {
    // Reactは子コンポーネントのエフェクトを親(App)より先に実行するため、紹介URLへ直接
    // アクセスした際の最初の商品取得リクエストは、Cookie書き込みuseEffectより先に飛ぶことがある。
    // その場合でもCookie無し・URLのrefクエリのみで通過できることを確認する(回帰防止)。
    it('紹介Cookieが無くても?ref=があれば商品一覧を200で取得できる', async () => {
      const res = await request(app).get('/api/products?ref=TEST-REF');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.products)).toBe(true);
    });

    it('紹介Cookieが無くても?ref=があれば商品詳細を200で取得できる', async () => {
      const res = await request(app).get(`/api/products/${productSlug}?ref=TEST-REF`);
      expect(res.status).toBe(200);
      expect(res.body.product.slug).toBe(productSlug);
    });

    it('refクエリが空文字の場合は403のまま', async () => {
      const res = await request(app).get('/api/products?ref=');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('REFERRAL_REQUIRED');
    });

    // 2026-07-22 千ノ国全体連携パッケージの新規指摘の回帰テスト(SYSTEM_ANALYSIS 15.3): 以前は
    // refクエリの中身を検証せず、空でなければ何でも通過させていたため、実在しないコードでも
    // 非公開の商品カタログが閲覧できてしまっていた。
    it('refクエリが実在しないreferral_links.codeの場合は403になる(仕様書外の拡張)', async () => {
      const res = await request(app).get('/api/products?ref=NOT-A-REAL-CODE');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('REFERRAL_REQUIRED');
    });

    it('refクエリがinactive化されたreferral_links.codeの場合は403になる(仕様書外の拡張)', async () => {
      await prisma.referralLink.create({ data: { code: 'TEST-REF-INACTIVE', agencyId, status: 'inactive' } });
      const res = await request(app).get('/api/products?ref=TEST-REF-INACTIVE');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('REFERRAL_REQUIRED');
      await prisma.referralLink.deleteMany({ where: { code: 'TEST-REF-INACTIVE' } });
    });
  });
});
