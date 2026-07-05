import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();

describe('POST /api/cart/validate', () => {
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    const product = await prisma.product.create({
      data: {
        name: 'テスト商品',
        slug: `test-cart-product-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 1000,
        status: 'published',
      },
    });
    productId = product.id;

    const variant = await prisma.productVariant.create({
      data: {
        productId,
        name: 'テストバリエーション',
        price: 1000,
        stock: 5,
        reservedStock: 3,
      },
    });
    variantId = variant.id;
  });

  afterAll(async () => {
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.$disconnect();
  });

  it('在庫が足りる数量ならvalid=trueを返す', async () => {
    const res = await request(app)
      .post('/api/cart/validate')
      .set('Origin', 'http://localhost:5173')
      .send({ items: [{ variantId, quantity: 2 }] });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.items[0].availableStock).toBe(2);
    expect(res.body.items[0].stockInsufficient).toBe(false);
  });

  it('販売可能数(stock - reserved_stock)を超える数量はvalid=falseを返す', async () => {
    const res = await request(app)
      .post('/api/cart/validate')
      .set('Origin', 'http://localhost:5173')
      .send({ items: [{ variantId, quantity: 3 }] });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.items[0].stockInsufficient).toBe(true);
  });

  it('存在しないバリエーションはfound=falseを返す', async () => {
    const res = await request(app)
      .post('/api/cart/validate')
      .set('Origin', 'http://localhost:5173')
      .send({ items: [{ variantId: '00000000-0000-0000-0000-000000000000', quantity: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.items[0].found).toBe(false);
  });

  it('不正なリクエストは400を返す', async () => {
    const res = await request(app)
      .post('/api/cart/validate')
      .set('Origin', 'http://localhost:5173')
      .send({ items: [{ variantId, quantity: 0 }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CART_ITEMS');
  });
});
