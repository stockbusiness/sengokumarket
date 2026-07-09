import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import {
  cancelCouponUsage,
  confirmCouponUsage,
  reserveCouponUsage,
  restoreCouponUsageOnFullRefund,
  validateCoupon,
} from './coupon';

const MARK = 'coupon-svc-test';

async function createCoupon(overrides: Partial<Parameters<typeof prisma.coupon.create>[0]['data']> = {}) {
  return prisma.coupon.create({
    data: {
      code: `${MARK}-${Math.random().toString(36).slice(2)}`,
      name: 'テストクーポン',
      discountType: 'fixed',
      discountAmount: 5000,
      ...overrides,
    },
  });
}

async function createOrderStub(userId: string | null = null) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `SG-${MARK}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      userId: userId ?? undefined,
      totalAmount: 50000,
      originalAmount: 50000,
      paymentStatus: 'pending',
      orderStatus: 'pending',
      customerName: 'テスト',
      customerEmail: `${MARK}-${Math.random().toString(36).slice(2)}@example.com`,
      termsAgreedAt: new Date(),
      termsVersion: '2026-07-01',
    },
  });
  return order.id;
}

describe('coupon service(仕様書外の拡張・クーポン機能)', () => {
  afterAll(async () => {
    await prisma.couponUsage.deleteMany({ where: { coupon: { code: { contains: MARK } } } });
    await prisma.order.deleteMany({ where: { orderNumber: { contains: MARK } } });
    await prisma.couponAgency.deleteMany({ where: { coupon: { code: { contains: MARK } } } });
    await prisma.couponCustomer.deleteMany({ where: { coupon: { code: { contains: MARK } } } });
    await prisma.couponProduct.deleteMany({ where: { coupon: { code: { contains: MARK } } } });
    await prisma.coupon.deleteMany({ where: { code: { contains: MARK } } });
    await prisma.user.deleteMany({ where: { email: { contains: MARK } } });
    await prisma.agency.deleteMany({ where: { code: { contains: MARK } } });
    await prisma.product.deleteMany({ where: { slug: { contains: MARK } } });
    await prisma.$disconnect();
  });

  describe('割引額の計算', () => {
    it('固定額割引: 対象金額を超えない', async () => {
      const coupon = await createCoupon({ discountAmount: 100000 });
      const result = await prisma.$transaction((tx) =>
        validateCoupon(tx, { code: coupon.code, userId: null, agencyId: null, items: [{ productId: 'p1', subtotal: 50000 }] }),
      );
      expect(result.discountAmount).toBe(50000);
      expect(result.finalAmount).toBe(0);
    });

    it('割引率: 1円未満切り捨て、最大割引額でキャップされる', async () => {
      const coupon = await createCoupon({
        discountType: 'percentage',
        discountAmount: null,
        discountPercentage: 33,
        maximumDiscountAmount: 1000,
      });
      // 33% of 3333 = 1099.89 -> floor 1099 -> capped to 1000
      const result = await prisma.$transaction((tx) =>
        validateCoupon(tx, { code: coupon.code, userId: null, agencyId: null, items: [{ productId: 'p1', subtotal: 3333 }] }),
      );
      expect(result.discountAmount).toBe(1000);
      expect(result.finalAmount).toBe(2333);
    });
  });

  describe('検証ルール', () => {
    it('存在しないコードはCOUPON_NOT_FOUND', async () => {
      await expect(
        prisma.$transaction((tx) =>
          validateCoupon(tx, { code: `${MARK}-NONE`, userId: null, agencyId: null, items: [{ productId: 'p1', subtotal: 10000 }] }),
        ),
      ).rejects.toMatchObject({ code: 'COUPON_NOT_FOUND' });
    });

    it('無効化されたクーポンはCOUPON_INACTIVE', async () => {
      const coupon = await createCoupon({ isActive: false });
      await expect(
        prisma.$transaction((tx) =>
          validateCoupon(tx, { code: coupon.code, userId: null, agencyId: null, items: [{ productId: 'p1', subtotal: 10000 }] }),
        ),
      ).rejects.toMatchObject({ code: 'COUPON_INACTIVE' });
    });

    it('有効期限切れはCOUPON_EXPIRED', async () => {
      const coupon = await createCoupon({ expiresAt: new Date(Date.now() - 1000) });
      await expect(
        prisma.$transaction((tx) =>
          validateCoupon(tx, { code: coupon.code, userId: null, agencyId: null, items: [{ productId: 'p1', subtotal: 10000 }] }),
        ),
      ).rejects.toMatchObject({ code: 'COUPON_EXPIRED' });
    });

    it('開始日前はCOUPON_NOT_STARTED', async () => {
      const coupon = await createCoupon({ startsAt: new Date(Date.now() + 60 * 60 * 1000) });
      await expect(
        prisma.$transaction((tx) =>
          validateCoupon(tx, { code: coupon.code, userId: null, agencyId: null, items: [{ productId: 'p1', subtotal: 10000 }] }),
        ),
      ).rejects.toMatchObject({ code: 'COUPON_NOT_STARTED' });
    });

    it('最低購入金額未満はCOUPON_MINIMUM_NOT_MET', async () => {
      const coupon = await createCoupon({ minimumOrderAmount: 20000 });
      await expect(
        prisma.$transaction((tx) =>
          validateCoupon(tx, { code: coupon.code, userId: null, agencyId: null, items: [{ productId: 'p1', subtotal: 10000 }] }),
        ),
      ).rejects.toMatchObject({ code: 'COUPON_MINIMUM_NOT_MET' });
    });

    async function createTestProduct(slugSuffix: string) {
      const product = await prisma.product.create({
        data: {
          name: 'テスト商品',
          slug: `${MARK}-${slugSuffix}-${Math.random().toString(36).slice(2)}`,
          category: 'テスト',
          itemType: 'nft',
          basePrice: 10000,
          status: 'published',
        },
      });
      return product.id;
    }

    it('対象商品スコープ(include)から外れるとCOUPON_PRODUCT_NOT_ELIGIBLE', async () => {
      const eligibleProductId = await createTestProduct('eligible');
      const otherProductId = await createTestProduct('other');
      const coupon = await createCoupon({ productScopeType: 'include' });
      await prisma.couponProduct.create({ data: { couponId: coupon.id, productId: eligibleProductId, relationType: 'include' } });

      await expect(
        prisma.$transaction((tx) =>
          validateCoupon(tx, {
            code: coupon.code,
            userId: null,
            agencyId: null,
            items: [{ productId: otherProductId, subtotal: 10000 }],
          }),
        ),
      ).rejects.toMatchObject({ code: 'COUPON_PRODUCT_NOT_ELIGIBLE' });

      const ok = await prisma.$transaction((tx) =>
        validateCoupon(tx, {
          code: coupon.code,
          userId: null,
          agencyId: null,
          items: [{ productId: eligibleProductId, subtotal: 10000 }],
        }),
      );
      expect(ok.discountAmount).toBe(5000);
    });

    it('除外商品(exclude)は割引対象から除かれるが、他の商品には適用される', async () => {
      const excludedProductId = await createTestProduct('excluded');
      const otherProductId = await createTestProduct('included');
      const coupon = await createCoupon({ productScopeType: 'exclude' });
      await prisma.couponProduct.create({ data: { couponId: coupon.id, productId: excludedProductId, relationType: 'exclude' } });

      const result = await prisma.$transaction((tx) =>
        validateCoupon(tx, {
          code: coupon.code,
          userId: null,
          agencyId: null,
          items: [
            { productId: excludedProductId, subtotal: 10000 },
            { productId: otherProductId, subtotal: 20000 },
          ],
        }),
      );
      // eligibleAmount=20000だが discountAmount(fixed 5000)は対象金額を超えない範囲でそのまま適用
      expect(result.eligibleAmount).toBe(20000);
      expect(result.discountAmount).toBe(5000);
      expect(result.originalAmount).toBe(30000);
      expect(result.finalAmount).toBe(25000);
    });

    it('対象代理店スコープ(include)から外れるとCOUPON_AGENCY_NOT_ELIGIBLE', async () => {
      const agency = await prisma.agency.create({ data: { name: 'テスト代理店', code: `${MARK}-AG`, defaultCommissionRate: 0 } });
      const coupon = await createCoupon({ agencyScopeType: 'include' });
      await prisma.couponAgency.create({ data: { couponId: coupon.id, agencyId: agency.id } });

      await expect(
        prisma.$transaction((tx) =>
          validateCoupon(tx, { code: coupon.code, userId: null, agencyId: null, items: [{ productId: 'p1', subtotal: 10000 }] }),
        ),
      ).rejects.toMatchObject({ code: 'COUPON_AGENCY_NOT_ELIGIBLE' });

      const ok = await prisma.$transaction((tx) =>
        validateCoupon(tx, { code: coupon.code, userId: null, agencyId: agency.id, items: [{ productId: 'p1', subtotal: 10000 }] }),
      );
      expect(ok.discountAmount).toBe(5000);
    });

    it('新規顧客限定クーポンは既存の支払済み注文がある顧客にはCOUPON_CUSTOMER_NOT_ELIGIBLE', async () => {
      const user = await prisma.user.create({
        data: { name: 'テスト', email: `${MARK}-repeat@example.com`, passwordHash: 'x', role: 'user' },
      });
      await prisma.order.create({
        data: {
          orderNumber: `SG-${MARK}-PAID-${Date.now()}`,
          userId: user.id,
          totalAmount: 1000,
          originalAmount: 1000,
          paymentStatus: 'paid',
          orderStatus: 'paid',
          customerName: 'テスト',
          customerEmail: user.email,
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
        },
      });

      const coupon = await createCoupon({ customerScopeType: 'new_customer' });
      await expect(
        prisma.$transaction((tx) =>
          validateCoupon(tx, { code: coupon.code, userId: user.id, agencyId: null, items: [{ productId: 'p1', subtotal: 10000 }] }),
        ),
      ).rejects.toMatchObject({ code: 'COUPON_CUSTOMER_NOT_ELIGIBLE' });
    });

    it('総利用回数の上限に達しているとCOUPON_USAGE_LIMIT_REACHED', async () => {
      const coupon = await createCoupon({ totalUsageLimit: 1, usedCount: 1 });
      await expect(
        prisma.$transaction((tx) =>
          validateCoupon(tx, { code: coupon.code, userId: null, agencyId: null, items: [{ productId: 'p1', subtotal: 10000 }] }),
        ),
      ).rejects.toMatchObject({ code: 'COUPON_USAGE_LIMIT_REACHED' });
    });
  });

  describe('予約→確定/解放のライフサイクル', () => {
    it('reserveCouponUsageで予約し、confirmCouponUsageでused_countが加算されreservedCountが戻る', async () => {
      const coupon = await createCoupon({ totalUsageLimit: 5 });
      const orderId = await createOrderStub();

      await prisma.$transaction((tx) =>
        reserveCouponUsage(tx, { code: coupon.code, userId: null, agencyId: null, items: [{ productId: 'p1', subtotal: 50000 }], orderId }),
      );

      const afterReserve = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
      expect(afterReserve.reservedCount).toBe(1);
      expect(afterReserve.usedCount).toBe(0);

      await prisma.$transaction((tx) => confirmCouponUsage(tx, orderId));

      const afterConfirm = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
      expect(afterConfirm.reservedCount).toBe(0);
      expect(afterConfirm.usedCount).toBe(1);

      const usage = await prisma.couponUsage.findUniqueOrThrow({ where: { orderId } });
      expect(usage.status).toBe('used');
    });

    it('cancelCouponUsageでreservedCountが解放され、再利用可能に戻る', async () => {
      const coupon = await createCoupon({});
      const orderId = await createOrderStub();

      await prisma.$transaction((tx) =>
        reserveCouponUsage(tx, { code: coupon.code, userId: null, agencyId: null, items: [{ productId: 'p1', subtotal: 50000 }], orderId }),
      );
      await prisma.$transaction((tx) => cancelCouponUsage(tx, orderId, 'expired'));

      const after = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
      expect(after.reservedCount).toBe(0);

      const usage = await prisma.couponUsage.findUniqueOrThrow({ where: { orderId } });
      expect(usage.status).toBe('expired');
    });

    it('全額返金時、restoreOnCancel=trueならusedCountが戻り再利用可能になる', async () => {
      const coupon = await createCoupon({ restoreOnCancel: true });
      const orderId = await createOrderStub();

      await prisma.$transaction((tx) =>
        reserveCouponUsage(tx, { code: coupon.code, userId: null, agencyId: null, items: [{ productId: 'p1', subtotal: 50000 }], orderId }),
      );
      await prisma.$transaction((tx) => confirmCouponUsage(tx, orderId));
      await prisma.$transaction((tx) => restoreCouponUsageOnFullRefund(tx, orderId));

      const after = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
      expect(after.usedCount).toBe(0);

      const usage = await prisma.couponUsage.findUniqueOrThrow({ where: { orderId } });
      expect(usage.status).toBe('cancelled');
    });

    it('全額返金時、restoreOnCancel=falseなら使用済みのまま(復活しない)', async () => {
      const coupon = await createCoupon({ restoreOnCancel: false });
      const orderId = await createOrderStub();

      await prisma.$transaction((tx) =>
        reserveCouponUsage(tx, { code: coupon.code, userId: null, agencyId: null, items: [{ productId: 'p1', subtotal: 50000 }], orderId }),
      );
      await prisma.$transaction((tx) => confirmCouponUsage(tx, orderId));
      await prisma.$transaction((tx) => restoreCouponUsageOnFullRefund(tx, orderId));

      const after = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
      expect(after.usedCount).toBe(1);

      const usage = await prisma.couponUsage.findUniqueOrThrow({ where: { orderId } });
      expect(usage.status).toBe('used');
    });
  });

  describe('同時実行(仕様書19.4)', () => {
    it('利用上限1回のクーポンを複数注文が同時に予約しようとすると、1件だけ成功する', async () => {
      const coupon = await createCoupon({ totalUsageLimit: 1 });
      const orderIds = await Promise.all([createOrderStub(), createOrderStub(), createOrderStub()]);

      const results = await Promise.allSettled(
        orderIds.map((orderId) =>
          prisma.$transaction((tx) =>
            reserveCouponUsage(tx, {
              code: coupon.code,
              userId: null,
              agencyId: null,
              items: [{ productId: 'p1', subtotal: 50000 }],
              orderId,
            }),
          ),
        ),
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r) => r.status === 'rejected');
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(2);

      const after = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
      expect(after.reservedCount).toBe(1);
    });
  });
});
