import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { createPendingOrder } from './createPendingOrder.usecase';

const PRODUCT_PREFIX = 'create-pending-order-metrics-test-';

async function createProductWithVariant(suffix: string, stock: number) {
  const product = await prisma.product.create({
    data: {
      name: `${PRODUCT_PREFIX}${suffix}`,
      slug: `${PRODUCT_PREFIX}${suffix}-${Date.now()}`,
      category: 'テスト',
      itemType: 'membership',
      basePrice: 10000,
      status: 'published',
    },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, name: 'A', price: 10000, stock, reservedStock: 0 },
  });
  return { product, variant };
}

async function cleanup(productId: string) {
  await prisma.orderItem.deleteMany({ where: { productId } });
  await prisma.order.deleteMany({ where: { customerEmail: { contains: PRODUCT_PREFIX } } });
  await prisma.productVariant.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
}

// 最終安定化指示書Phase10「Checkout性能改善」: HTTPルート(POST /api/checkout/create-session)は
// IP単位のレート制限(dbRateLimit)がかかっているため、UseCase自体を直接呼んでメトリクス出力を
// 確認する(rate limitへ影響を与えないようにするため)。
describe('createPendingOrder: checkout.*メトリクスのログ出力(最終安定化指示書Phase10)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('checkout.*の工程別メトリクス・query_countをログへ出力する', async () => {
    const { product, variant } = await createProductWithVariant('basic', 5);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await createPendingOrder({
        customerName: 'メトリクステスト太郎',
        customerEmail: `${PRODUCT_PREFIX}${Date.now()}@example.com`,
        customerPhone: '090-0000-0000',
        customerPostalCode: '100-0001',
        customerAddress: '東京都千代田区1-1-1',
        agreedToTerms: true,
        items: [{ variantId: variant.id, quantity: 1 }],
      });

      const metricLogCall = logSpy.mock.calls.find((call) => typeof call[0] === 'string' && call[0].includes('"metric":"checkout"'));
      expect(metricLogCall).toBeTruthy();
      const parsed = JSON.parse(metricLogCall![0] as string);
      expect(parsed['checkout.total_transaction_ms']).toBeGreaterThanOrEqual(0);
      expect(parsed['checkout.validation_ms']).toBeGreaterThanOrEqual(0);
      expect(parsed['checkout.lock_ms']).toBeGreaterThanOrEqual(0);
      expect(parsed['checkout.purchaser_ms']).toBeGreaterThanOrEqual(0);
      expect(parsed['checkout.pricing_ms']).toBeGreaterThanOrEqual(0);
      expect(parsed['checkout.order_write_ms']).toBeGreaterThanOrEqual(0);
      expect(parsed['checkout.side_effects_ms']).toBeGreaterThanOrEqual(0);
      expect(parsed['checkout.query_count']).toBeGreaterThan(0);
    } finally {
      logSpy.mockRestore();
      await cleanup(product.id);
    }
  });
});
