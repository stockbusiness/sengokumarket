import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

describe('管理API: 商品管理', () => {
  let agent: Awaited<ReturnType<typeof createAdminAgent>>['agent'];
  const slug = `admin-test-product-${Date.now()}`;

  afterAll(async () => {
    await prisma.productVariant.deleteMany({ where: { product: { slug } } });
    await prisma.product.deleteMany({ where: { slug } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('バリエーション付きで商品を新規作成できる', async () => {
    ({ agent } = await createAdminAgent(app));

    const res = await agent
      .post('/api/admin/products')
      .set('Origin', TEST_ORIGIN)
      .send({
        name: '管理画面テスト商品',
        slug,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 12000,
        status: 'draft',
        variants: [{ name: 'A', price: 12000, stock: 5 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.product.variants).toHaveLength(1);
  });

  it('同じslugは409を返す', async () => {
    const res = await agent
      .post('/api/admin/products')
      .set('Origin', TEST_ORIGIN)
      .send({ name: '重複', slug, category: 'テスト', itemType: 'nft', basePrice: 1000 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLUG_ALREADY_EXISTS');
  });

  it('公開ステータスと在庫を更新できる', async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { slug }, include: { variants: true } });

    const res = await agent
      .put(`/api/admin/products/${product.id}`)
      .set('Origin', TEST_ORIGIN)
      .send({ status: 'published', variants: [{ id: product.variants[0].id, name: 'A', price: 12000, stock: 20 }] });

    expect(res.status).toBe(200);
    expect(res.body.product.status).toBe('published');
    expect(res.body.product.variants[0].stock).toBe(20);
  });

  it('不正な商品タイプは400を返す', async () => {
    const res = await agent
      .post('/api/admin/products')
      .set('Origin', TEST_ORIGIN)
      .send({ name: 'x', slug: `${slug}-invalid`, category: 'テスト', itemType: 'invalid_type', basePrice: 1000 });

    expect(res.status).toBe(400);
  });
});
