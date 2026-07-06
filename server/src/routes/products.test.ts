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
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { slug: productSlug } });
    await prisma.user.deleteMany({ where: { email: { contains: 'referralgate-test' } } });
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
});
