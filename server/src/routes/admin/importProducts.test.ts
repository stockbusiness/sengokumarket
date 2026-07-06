import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();
const marker = `csvtest${Date.now()}`;

function csvHeader() {
  return '商品名,slug,商品説明,カテゴリ,商品タイプ,バリエーション名,SKU,価格,在庫数,公開ステータス';
}

describe('管理API: CSV商品インポート', () => {
  afterAll(async () => {
    await prisma.productVariant.deleteMany({ where: { sku: { startsWith: marker } } });
    await prisma.product.deleteMany({ where: { slug: { startsWith: marker } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('プレビュー(dryRun)ではDBに書き込まれない', async () => {
    const { agent } = await createAdminAgent(app);
    const csv = [
      csvHeader(),
      `テスト商品,${marker}-a,説明文,カテゴリ,nft,Black,${marker}-sku-a,10000,50,published`,
    ].join('\n');

    const res = await agent
      .post('/api/admin/import-products')
      .set('Origin', TEST_ORIGIN)
      .send({ csvContent: csv, dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.results[0].action).toBe('create_product_and_variant');
    expect(res.body.errorCount).toBe(0);

    const product = await prisma.product.findUnique({ where: { slug: `${marker}-a` } });
    expect(product).toBeNull();
  });

  it('実インポートで商品とバリエーションが作成される', async () => {
    const { agent } = await createAdminAgent(app);
    const csv = [
      csvHeader(),
      `テスト商品,${marker}-b,説明文,カテゴリ,nft,Black,${marker}-sku-b,10000,50,published`,
    ].join('\n');

    const res = await agent
      .post('/api/admin/import-products')
      .set('Origin', TEST_ORIGIN)
      .send({ csvContent: csv, dryRun: false });

    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(1);

    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: `${marker}-b` },
      include: { variants: true },
    });
    expect(product.itemType).toBe('nft');
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0].stock).toBe(50);
  });

  it('同じSKUを再インポートすると更新(upsert)される', async () => {
    const { agent } = await createAdminAgent(app);
    const csv = [
      csvHeader(),
      `テスト商品改,${marker}-b,説明文改,カテゴリ,nft,Black改,${marker}-sku-b,12000,80,published`,
    ].join('\n');

    const res = await agent
      .post('/api/admin/import-products')
      .set('Origin', TEST_ORIGIN)
      .send({ csvContent: csv, dryRun: false });

    expect(res.status).toBe(200);
    expect(res.body.results[0].action).toBe('update_variant');

    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { sku: `${marker}-sku-b` } });
    expect(variant.price).toBe(12000);
    expect(variant.stock).toBe(80);

    const variantCount = await prisma.productVariant.count({ where: { sku: `${marker}-sku-b` } });
    expect(variantCount).toBe(1);
  });

  it('商品タイプが空欄の行はエラーになり、商品は作成されない', async () => {
    const { agent } = await createAdminAgent(app);
    const csv = [csvHeader(), `テスト商品,${marker}-noitemtype,説明,カテゴリ,,Black,${marker}-sku-noitemtype,10000,10,published`].join(
      '\n',
    );

    const res = await agent
      .post('/api/admin/import-products')
      .set('Origin', TEST_ORIGIN)
      .send({ csvContent: csv, dryRun: false });

    expect(res.status).toBe(200);
    expect(res.body.errorCount).toBe(1);
    expect(res.body.results[0].action).toBe('error');
    expect(res.body.results[0].errors.join('')).toContain('商品タイプ');
    expect(res.body.results[0].line).toBe(2);

    const product = await prisma.product.findUnique({ where: { slug: `${marker}-noitemtype` } });
    expect(product).toBeNull();
  });

  it('不正な商品タイプの値はエラーになる', async () => {
    const { agent } = await createAdminAgent(app);
    const csv = [
      csvHeader(),
      `テスト商品,${marker}-badtype,説明,カテゴリ,invalid_type,Black,${marker}-sku-badtype,10000,10,published`,
    ].join('\n');

    const res = await agent
      .post('/api/admin/import-products')
      .set('Origin', TEST_ORIGIN)
      .send({ csvContent: csv, dryRun: false });

    expect(res.body.errorCount).toBe(1);
    expect(res.body.results[0].action).toBe('error');
  });

  it('複数行のうち一部が不正でも、正常な行だけインポートされ行番号付きでエラー表示される', async () => {
    const { agent } = await createAdminAgent(app);
    const csv = [
      csvHeader(),
      `正常商品,${marker}-mix-ok,説明,カテゴリ,nft,A,${marker}-sku-mix-ok,5000,10,published`,
      `異常商品,${marker}-mix-ng,説明,カテゴリ,,A,${marker}-sku-mix-ng,5000,10,published`,
    ].join('\n');

    const res = await agent
      .post('/api/admin/import-products')
      .set('Origin', TEST_ORIGIN)
      .send({ csvContent: csv, dryRun: false });

    expect(res.body.successCount).toBe(1);
    expect(res.body.errorCount).toBe(1);
    expect(res.body.results.find((r: { line: number }) => r.line === 2)?.action).toBe('create_product_and_variant');
    expect(res.body.results.find((r: { line: number }) => r.line === 3)?.action).toBe('error');

    const okProduct = await prisma.product.findUnique({ where: { slug: `${marker}-mix-ok` } });
    expect(okProduct).not.toBeNull();
    const ngProduct = await prisma.product.findUnique({ where: { slug: `${marker}-mix-ng` } });
    expect(ngProduct).toBeNull();
  });
});
