import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const put = vi.fn(async (pathname: string, ..._rest: unknown[]) => ({ url: `https://example-blob.vercel-storage.com/${pathname}` }));

vi.mock('@vercel/blob', () => ({
  put: (...args: [string, unknown, unknown]) => put(...args),
}));

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
    // 仕様書外の拡張(千ノ国5システム共通方針書v3.0 15章): 未指定時はhybridで初期化される。
    expect(res.body.product.salesModel).toBe('hybrid');
  });

  it('sales_modelを指定して商品を作成できる', async () => {
    const agentRequiredSlug = `admin-test-agent-required-${Date.now()}`;
    const res = await agent
      .post('/api/admin/products')
      .set('Origin', TEST_ORIGIN)
      .send({
        name: '代理店必須商品テスト',
        slug: agentRequiredSlug,
        category: 'テスト',
        itemType: 'membership',
        salesModel: 'agent_required',
        basePrice: 500000,
      });

    expect(res.status).toBe(201);
    expect(res.body.product.salesModel).toBe('agent_required');

    await prisma.product.delete({ where: { slug: agentRequiredSlug } });
  });

  // 購入後代理店システム連携実装指示書 6.3章。
  it('agencyAccessMode=agent_portalの場合agencyRole・agencyProductCodeが無いと400を返す', async () => {
    const res = await agent
      .post('/api/admin/products')
      .set('Origin', TEST_ORIGIN)
      .send({
        name: '代理店ポータルテスト(役割未入力)',
        slug: `admin-test-agent-portal-invalid-${Date.now()}`,
        category: 'テスト',
        itemType: 'membership',
        basePrice: 30000,
        agencyAccessMode: 'agent_portal',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('agencyAccessMode=agent_portalをagencyRole・agencyProductCode付きで作成できる', async () => {
    const agentPortalSlug = `admin-test-agent-portal-valid-${Date.now()}`;
    const res = await agent
      .post('/api/admin/products')
      .set('Origin', TEST_ORIGIN)
      .send({
        name: '代理店ポータルテスト',
        slug: agentPortalSlug,
        category: 'テスト',
        itemType: 'membership',
        basePrice: 30000,
        agencyAccessMode: 'agent_portal',
        agencyRole: 'participant',
        agencyProductCode: 'agency_entry_plan',
        agencyAccessExpiresDays: 30,
      });

    expect(res.status).toBe(201);
    expect(res.body.product.agencyAccessMode).toBe('agent_portal');
    expect(res.body.product.agencyRole).toBe('participant');
    expect(res.body.product.agencyProductCode).toBe('agency_entry_plan');
    expect(res.body.product.agencyAccessExpiresDays).toBe(30);

    await prisma.product.delete({ where: { slug: agentPortalSlug } });
  });

  it('既にagent_portalの商品からagencyRoleだけをnullへ更新しようとすると400を返す', async () => {
    const agentPortalSlug = `admin-test-agent-portal-update-${Date.now()}`;
    const created = await agent.post('/api/admin/products').set('Origin', TEST_ORIGIN).send({
      name: '代理店ポータル更新テスト',
      slug: agentPortalSlug,
      category: 'テスト',
      itemType: 'membership',
      basePrice: 30000,
      agencyAccessMode: 'agent_portal',
      agencyRole: 'participant',
      agencyProductCode: 'agency_entry_plan',
    });

    const res = await agent
      .put(`/api/admin/products/${created.body.product.id}`)
      .set('Origin', TEST_ORIGIN)
      .send({ agencyRole: null });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    await prisma.product.delete({ where: { slug: agentPortalSlug } });
  });

  it('不正なsales_modelは400を返す', async () => {
    const res = await agent
      .post('/api/admin/products')
      .set('Origin', TEST_ORIGIN)
      .send({
        name: '不正販売方式テスト',
        slug: `admin-test-invalid-salesmodel-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        salesModel: 'not-a-real-model',
        basePrice: 1000,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('同じslugは409を返す', async () => {
    const res = await agent
      .post('/api/admin/products')
      .set('Origin', TEST_ORIGIN)
      .send({ name: '重複', slug, category: 'テスト', itemType: 'nft', basePrice: 1000 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLUG_ALREADY_EXISTS');
  });

  it('商品を単体取得できる(編集ページ用)', async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { slug }, include: { variants: true } });
    const res = await agent.get(`/api/admin/products/${product.id}`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.product.id).toBe(product.id);
    expect(res.body.product.variants).toHaveLength(1);
  });

  it('存在しない商品の単体取得は404を返す', async () => {
    const res = await agent
      .get('/api/admin/products/00000000-0000-0000-0000-000000000000')
      .set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
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

  // basePriceは一覧表示用の代表(最安)価格に過ぎず、実際に決済で使われるのはバリエーションごとの
  // priceである(残課題指示書第15章・バリエーション別価格へ移行)。basePriceの変更が既存の
  // バリエーションpriceを巻き込んで書き換えないことの回帰テスト。
  it('basePriceを変更しても既存バリエーションのpriceは変更されない', async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { slug }, include: { variants: true } });
    const originalVariantPrice = product.variants[0].price;

    const res = await agent
      .put(`/api/admin/products/${product.id}`)
      .set('Origin', TEST_ORIGIN)
      .send({ basePrice: 27500 });

    expect(res.status).toBe(200);
    expect(res.body.product.basePrice).toBe(27500);
    expect(res.body.product.variants[0].price).toBe(originalVariantPrice);

    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: product.variants[0].id } });
    expect(variant.price).toBe(originalVariantPrice);
  });

  it('バリエーションごとに個別の価格を指定して更新できる', async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { slug }, include: { variants: true } });

    const res = await agent
      .put(`/api/admin/products/${product.id}`)
      .set('Origin', TEST_ORIGIN)
      .send({ variants: [{ id: product.variants[0].id, price: 33000 }] });

    expect(res.status).toBe(200);
    expect(res.body.product.variants[0].price).toBe(33000);
    expect(res.body.product.basePrice).not.toBe(33000);
  });

  it('sales_modelを更新できる', async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { slug } });

    const res = await agent
      .put(`/api/admin/products/${product.id}`)
      .set('Origin', TEST_ORIGIN)
      .send({ salesModel: 'agent_required' });

    expect(res.status).toBe(200);
    expect(res.body.product.salesModel).toBe('agent_required');

    // 他のテストへの影響を避けるためhybridへ戻す
    await agent.put(`/api/admin/products/${product.id}`).set('Origin', TEST_ORIGIN).send({ salesModel: 'hybrid' });
  });

  it('不正なsales_modelでの更新は400を返す', async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { slug } });

    const res = await agent
      .put(`/api/admin/products/${product.id}`)
      .set('Origin', TEST_ORIGIN)
      .send({ salesModel: 'not-a-real-model' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('不正な商品タイプは400を返す', async () => {
    const res = await agent
      .post('/api/admin/products')
      .set('Origin', TEST_ORIGIN)
      .send({ name: 'x', slug: `${slug}-invalid`, category: 'テスト', itemType: 'invalid_type', basePrice: 1000 });

    expect(res.status).toBe(400);
  });

  // 2026-07-22指示書 Stage3: バリエーション部分更新の回帰テスト。
  // 管理画面の在庫だけ編集する操作(AdminProductEditPage)は{ id, stock }のみを送るため、
  // 未指定のname/sku/priceを上書きしてはいけない。
  describe('バリエーションの部分更新(仕様書外の拡張・2026-07-22指示書Stage3)', () => {
    let partialUpdateProductId: string;
    let partialUpdateVariantId: string;

    beforeEach(async () => {
      const createRes = await agent
        .post('/api/admin/products')
        .set('Origin', TEST_ORIGIN)
        .send({
          name: '部分更新テスト商品',
          slug: `${slug}-partial-update-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          category: 'テスト',
          itemType: 'physical',
          basePrice: 5000,
          variants: [{ name: '通常', sku: 'ORIG-SKU-001', price: 5000, stock: 10 }],
        });
      partialUpdateProductId = createRes.body.product.id;
      partialUpdateVariantId = createRes.body.product.variants[0].id;
    });

    afterEach(async () => {
      await prisma.productVariant.deleteMany({ where: { productId: partialUpdateProductId } });
      await prisma.product.deleteMany({ where: { id: partialUpdateProductId } });
    });

    it('stockだけ更新してもSKU・name・priceが維持される', async () => {
      const res = await agent
        .put(`/api/admin/products/${partialUpdateProductId}`)
        .set('Origin', TEST_ORIGIN)
        .send({ variants: [{ id: partialUpdateVariantId, stock: 20 }] });

      expect(res.status).toBe(200);
      const variant = res.body.product.variants[0];
      expect(variant.stock).toBe(20);
      expect(variant.sku).toBe('ORIG-SKU-001');
      expect(variant.name).toBe('通常');
      expect(variant.price).toBe(5000);
    });

    it('priceだけ更新してもSKU・name・stockが維持される', async () => {
      const res = await agent
        .put(`/api/admin/products/${partialUpdateProductId}`)
        .set('Origin', TEST_ORIGIN)
        .send({ variants: [{ id: partialUpdateVariantId, price: 6000 }] });

      expect(res.status).toBe(200);
      const variant = res.body.product.variants[0];
      expect(variant.price).toBe(6000);
      expect(variant.sku).toBe('ORIG-SKU-001');
      expect(variant.name).toBe('通常');
      expect(variant.stock).toBe(10);
    });

    it('sku: nullを明示した場合のみSKUを解除できる', async () => {
      const res = await agent
        .put(`/api/admin/products/${partialUpdateProductId}`)
        .set('Origin', TEST_ORIGIN)
        .send({ variants: [{ id: partialUpdateVariantId, sku: null }] });

      expect(res.status).toBe(200);
      expect(res.body.product.variants[0].sku).toBeNull();
      expect(res.body.product.variants[0].name).toBe('通常');
      expect(res.body.product.variants[0].price).toBe(5000);
      expect(res.body.product.variants[0].stock).toBe(10);
    });

    it('存在しないvariant IDを含む更新は404を返し、既存バリエーションも変更されない', async () => {
      const res = await agent
        .put(`/api/admin/products/${partialUpdateProductId}`)
        .set('Origin', TEST_ORIGIN)
        .send({ variants: [{ id: '00000000-0000-0000-0000-000000000000', stock: 99 }] });

      expect(res.status).toBe(404);

      const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: partialUpdateVariantId } });
      expect(variant.stock).toBe(10);
    });

    it('不正な価格(負の数)を含む更新は400を返す', async () => {
      const res = await agent
        .put(`/api/admin/products/${partialUpdateProductId}`)
        .set('Origin', TEST_ORIGIN)
        .send({ variants: [{ id: partialUpdateVariantId, price: -100 }] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('新規バリエーション追加時はnameとpriceが必須', async () => {
      const res = await agent
        .put(`/api/admin/products/${partialUpdateProductId}`)
        .set('Origin', TEST_ORIGIN)
        .send({ variants: [{ stock: 5 }] });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  it('注文実績が無い商品は削除できる', async () => {
    const createRes = await agent
      .post('/api/admin/products')
      .set('Origin', TEST_ORIGIN)
      .send({ name: '削除対象', slug: `${slug}-deletable`, category: 'テスト', itemType: 'nft', basePrice: 1000 });
    const productId = createRes.body.product.id;

    const res = await agent.delete(`/api/admin/products/${productId}`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const found = await prisma.product.findUnique({ where: { id: productId } });
    expect(found).toBeNull();
  });

  describe('商品画像アップロード(仕様書外の拡張・Vercel Blob)', () => {
    const originalToken = process.env.BLOB_READ_WRITE_TOKEN;

    beforeEach(() => {
      process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
      put.mockClear();
    });

    afterEach(() => {
      process.env.BLOB_READ_WRITE_TOKEN = originalToken;
    });

    it('対応形式の画像をアップロードするとURLが返る', async () => {
      const res = await agent
        .post('/api/admin/products/upload-image')
        .set('Origin', TEST_ORIGIN)
        .attach('image', Buffer.from('fake-image-bytes'), { filename: 'test.png', contentType: 'image/png' });

      expect(res.status).toBe(201);
      expect(res.body.url).toContain('products/');
      expect(put).toHaveBeenCalledTimes(1);
    });

    it('ファイルが無い場合は400を返す', async () => {
      const res = await agent.post('/api/admin/products/upload-image').set('Origin', TEST_ORIGIN);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('対応していない形式は400を返す', async () => {
      const res = await agent
        .post('/api/admin/products/upload-image')
        .set('Origin', TEST_ORIGIN)
        .attach('image', Buffer.from('not-an-image'), { filename: 'test.txt', contentType: 'text/plain' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('BLOB_READ_WRITE_TOKEN未設定の場合は503を返す', async () => {
      delete process.env.BLOB_READ_WRITE_TOKEN;

      const res = await agent
        .post('/api/admin/products/upload-image')
        .set('Origin', TEST_ORIGIN)
        .attach('image', Buffer.from('fake-image-bytes'), { filename: 'test.png', contentType: 'image/png' });

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('BLOB_NOT_CONFIGURED');
    });
  });

  describe('バリエーション削除(仕様書外の拡張)', () => {
    it('注文実績が無いバリエーションは削除できる', async () => {
      const createRes = await agent
        .post('/api/admin/products')
        .set('Origin', TEST_ORIGIN)
        .send({
          name: 'バリエーション削除テスト',
          slug: `${slug}-variant-deletable`,
          category: 'テスト',
          itemType: 'nft',
          basePrice: 1000,
          variants: [{ name: '間違えて追加した行', price: 1000, stock: 0 }],
        });
      const productId = createRes.body.product.id;
      const variantId = createRes.body.product.variants[0].id;

      const res = await agent.delete(`/api/admin/products/${productId}/variants/${variantId}`).set('Origin', TEST_ORIGIN);
      expect(res.status).toBe(200);
      expect(res.body.product.variants).toHaveLength(0);

      await prisma.product.delete({ where: { id: productId } });
    });

    it('存在しないバリエーションの削除は404を返す', async () => {
      const product = await prisma.product.findUniqueOrThrow({ where: { slug } });
      const res = await agent
        .delete(`/api/admin/products/${product.id}/variants/00000000-0000-0000-0000-000000000000`)
        .set('Origin', TEST_ORIGIN);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('VARIANT_NOT_FOUND');
    });

    it('注文実績があるバリエーションは削除できない(VARIANT_HAS_ORDERS)', async () => {
      const createRes = await agent
        .post('/api/admin/products')
        .set('Origin', TEST_ORIGIN)
        .send({
          name: 'バリエーション削除禁止テスト',
          slug: `${slug}-variant-blocked`,
          category: 'テスト',
          itemType: 'nft',
          basePrice: 1000,
          variants: [{ name: '注文済み', price: 1000, stock: 5 }],
        });
      const product = createRes.body.product;
      const variant = product.variants[0];

      const user = await prisma.user.create({
        data: {
          name: 'admin-test バリエーション注文者',
          email: `admin-test-variant-orderer-${Date.now()}@example.com`,
          passwordHash: 'unused',
        },
      });
      const order = await prisma.order.create({
        data: {
          orderNumber: `admin-test-variant-order-${Date.now()}`,
          user: { connect: { id: user.id } },
          paymentStatus: 'paid',
          orderStatus: 'paid',
          totalAmount: 1000,
          originalAmount: 1000,
          customerName: '注文者',
          customerEmail: user.email,
          termsAgreedAt: new Date(),
          termsVersion: '1',
          orderItems: {
            create: {
              productId: product.id,
              variantId: variant.id,
              productName: product.name,
              variantName: variant.name,
              itemType: product.itemType,
              quantity: 1,
              unitPrice: 1000,
              subtotal: 1000,
            },
          },
        },
      });

      const res = await agent.delete(`/api/admin/products/${product.id}/variants/${variant.id}`).set('Origin', TEST_ORIGIN);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('VARIANT_HAS_ORDERS');

      await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
      await prisma.order.delete({ where: { id: order.id } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.productVariant.deleteMany({ where: { productId: product.id } });
      await prisma.product.delete({ where: { id: product.id } });
    });
  });

  it('注文実績がある商品は削除できない(PRODUCT_HAS_ORDERS)', async () => {
    const product = await prisma.product.findUniqueOrThrow({ where: { slug }, include: { variants: true } });

    const user = await prisma.user.create({
      data: {
        name: 'admin-test 注文者',
        email: `admin-test-orderer-${Date.now()}@example.com`,
        passwordHash: 'unused',
      },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: `admin-test-order-${Date.now()}`,
        user: { connect: { id: user.id } },
        paymentStatus: 'paid',
        orderStatus: 'paid',
        totalAmount: 12000,
        originalAmount: 12000,
        customerName: '注文者',
        customerEmail: user.email,
        termsAgreedAt: new Date(),
        termsVersion: '1',
        orderItems: {
          create: {
            productId: product.id,
            variantId: product.variants[0].id,
            productName: product.name,
            variantName: product.variants[0].name,
            itemType: product.itemType,
            quantity: 1,
            unitPrice: 12000,
            subtotal: 12000,
          },
        },
      },
    });

    const res = await agent.delete(`/api/admin/products/${product.id}`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRODUCT_HAS_ORDERS');

    await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
    await prisma.order.delete({ where: { id: order.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
});
