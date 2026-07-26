import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { getDigitalCollectibleRulesByProductIds, reserveProductSerialNumbers } from './digitalCollectible';

const PRODUCT_PREFIX = 'digital-collectible-test-product-';

async function createProduct(suffix: string) {
  return prisma.product.create({
    data: {
      name: `${PRODUCT_PREFIX}${suffix}`,
      slug: `${PRODUCT_PREFIX}${suffix}-${Date.now()}`,
      category: 'テスト',
      itemType: 'nft',
      basePrice: 10000,
      status: 'published',
    },
  });
}

// 最終安定化指示書Phase10「Checkout性能改善」: N+1削減のためにOrder Item単位のループから
// 切り出したバッチ取得ヘルパー自体の正しさを検証する。
describe('digitalCollectible: バッチ取得ヘルパー(最終安定化指示書Phase10)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('getDigitalCollectibleRulesByProductIds', () => {
    it('複数productId分のdigital_collectible有効ルールを1クエリでまとめて取得できる', async () => {
      const productA = await createProduct('rules-a');
      const productB = await createProduct('rules-b');
      const productC = await createProduct('rules-c-no-rule');
      await prisma.productIntegrationRule.create({
        data: { productId: productA.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true },
      });
      await prisma.productIntegrationRule.create({
        data: { productId: productB.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true },
      });

      const map = await prisma.$transaction((tx) =>
        getDigitalCollectibleRulesByProductIds(tx, [productA.id, productB.id, productC.id]),
      );

      expect(map.get(productA.id)?.productId).toBe(productA.id);
      expect(map.get(productB.id)?.productId).toBe(productB.id);
      expect(map.has(productC.id)).toBe(false);

      await prisma.productIntegrationRule.deleteMany({ where: { productId: { in: [productA.id, productB.id, productC.id] } } });
      await prisma.product.deleteMany({ where: { id: { in: [productA.id, productB.id, productC.id] } } });
    });

    it('enabled=falseのルールは含まれない', async () => {
      const product = await createProduct('rules-disabled');
      await prisma.productIntegrationRule.create({
        data: { productId: product.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: false },
      });

      const map = await prisma.$transaction((tx) => getDigitalCollectibleRulesByProductIds(tx, [product.id]));
      expect(map.has(product.id)).toBe(false);

      await prisma.productIntegrationRule.deleteMany({ where: { productId: product.id } });
      await prisma.product.deleteMany({ where: { id: product.id } });
    });

    it('空配列を渡すと空のMapを返す(クエリを発行しない)', async () => {
      const map = await prisma.$transaction((tx) => getDigitalCollectibleRulesByProductIds(tx, []));
      expect(map.size).toBe(0);
    });
  });

  describe('reserveProductSerialNumbers', () => {
    it('1回の呼び出しでcount分の連続した連番をまとめて確保する', async () => {
      const product = await createProduct('serial-batch');

      const serials = await prisma.$transaction((tx) => reserveProductSerialNumbers(tx, product.id, 5));
      expect(serials).toEqual([1, 2, 3, 4, 5]);

      const nextSerials = await prisma.$transaction((tx) => reserveProductSerialNumbers(tx, product.id, 3));
      expect(nextSerials).toEqual([6, 7, 8]);

      await prisma.product.deleteMany({ where: { id: product.id } });
    });

    it('count=0は空配列を返しカウンタを変更しない', async () => {
      const product = await createProduct('serial-zero');

      const serials = await prisma.$transaction((tx) => reserveProductSerialNumbers(tx, product.id, 0));
      expect(serials).toEqual([]);

      const nextSerials = await prisma.$transaction((tx) => reserveProductSerialNumbers(tx, product.id, 1));
      expect(nextSerials).toEqual([1]);

      await prisma.product.deleteMany({ where: { id: product.id } });
    });

    it('同時実行下でも重複しない連番範囲を返す(合計件数・一意性を確認)', async () => {
      const product = await createProduct('serial-concurrent');

      const results = await Promise.all([
        prisma.$transaction((tx) => reserveProductSerialNumbers(tx, product.id, 4)),
        prisma.$transaction((tx) => reserveProductSerialNumbers(tx, product.id, 6)),
      ]);
      const allSerials = results.flat();
      expect(allSerials).toHaveLength(10);
      expect(new Set(allSerials).size).toBe(10);
      expect(Math.min(...allSerials)).toBe(1);
      expect(Math.max(...allSerials)).toBe(10);

      await prisma.product.deleteMany({ where: { id: product.id } });
    });
  });
});
