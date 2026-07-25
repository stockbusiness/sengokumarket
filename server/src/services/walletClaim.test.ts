import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { createWalletClaimIfEligible, hashClaimToken, reissueWalletClaimToken } from './walletClaim';

const ORDER_PREFIX = 'SG-WALLETCLAIMTEST-';

async function createTestProduct(suffix: string, opts: { itemType?: string } = {}) {
  return prisma.product.create({
    data: {
      name: `wallet-claim-test-product-${suffix}`,
      slug: `wallet-claim-test-product-${suffix}`,
      category: 'テスト',
      itemType: opts.itemType ?? 'nft',
      basePrice: 10000,
      status: 'published',
    },
  });
}

async function createTestOrder(suffix: string) {
  return prisma.order.create({
    data: {
      orderNumber: `${ORDER_PREFIX}${suffix}`,
      totalAmount: 10000,
      originalAmount: 10000,
      paymentStatus: 'paid',
      orderStatus: 'paid',
      customerName: 'Claimテスト太郎',
      customerEmail: `wallet-claim-test-${suffix}@example.com`,
      termsAgreedAt: new Date(),
      termsVersion: '2026-07-01',
    },
  });
}

describe('walletClaim: createWalletClaimIfEligible', () => {
  const originalFlag = process.env.ENABLE_WALLET_CLAIM;

  afterEach(async () => {
    process.env.ENABLE_WALLET_CLAIM = originalFlag;
    await prisma.walletClaim.deleteMany({ where: { order: { orderNumber: { startsWith: ORDER_PREFIX } } } });
    await prisma.orderItem.deleteMany({ where: { order: { orderNumber: { startsWith: ORDER_PREFIX } } } });
    await prisma.order.deleteMany({ where: { orderNumber: { startsWith: ORDER_PREFIX } } });
    await prisma.productIntegrationRule.deleteMany({ where: { product: { name: { startsWith: 'wallet-claim-test-product-' } } } });
    await prisma.product.deleteMany({ where: { name: { startsWith: 'wallet-claim-test-product-' } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('ENABLE_WALLET_CLAIM=false(既定)の間は対象商品があってもWalletClaimを作成しない', async () => {
    delete process.env.ENABLE_WALLET_CLAIM;
    const product = await createTestProduct('flag-off');
    await prisma.productIntegrationRule.create({
      data: { productId: product.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible' },
    });
    const order = await createTestOrder('flag-off');
    const orderItem = await prisma.orderItem.create({
      data: { orderId: order.id, productId: product.id, productName: product.name, itemType: 'nft', quantity: 1, unitPrice: 10000, subtotal: 10000 },
    });

    const token = await prisma.$transaction((tx) => createWalletClaimIfEligible(tx, order, [orderItem]));
    expect(token).toBeNull();
    const claim = await prisma.walletClaim.findUnique({ where: { orderId: order.id } });
    expect(claim).toBeNull();
  });

  describe('ENABLE_WALLET_CLAIM=true', () => {
    beforeEach(() => {
      process.env.ENABLE_WALLET_CLAIM = 'true';
    });

    it('digital_collectibleの有効なルールがない商品はWalletClaimを作成しない', async () => {
      const product = await createTestProduct('no-rule');
      const order = await createTestOrder('no-rule');
      const orderItem = await prisma.orderItem.create({
        data: { orderId: order.id, productId: product.id, productName: product.name, itemType: 'nft', quantity: 1, unitPrice: 10000, subtotal: 10000 },
      });

      const token = await prisma.$transaction((tx) => createWalletClaimIfEligible(tx, order, [orderItem]));
      expect(token).toBeNull();
    });

    it('itemType!=nftの商品は対象外', async () => {
      const product = await createTestProduct('physical', { itemType: 'physical' });
      await prisma.productIntegrationRule.create({
        data: { productId: product.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible' },
      });
      const order = await createTestOrder('physical');
      const orderItem = await prisma.orderItem.create({
        data: { orderId: order.id, productId: product.id, productName: product.name, itemType: 'physical', quantity: 1, unitPrice: 10000, subtotal: 10000 },
      });

      const token = await prisma.$transaction((tx) => createWalletClaimIfEligible(tx, order, [orderItem]));
      expect(token).toBeNull();
    });

    it('digital_collectible対象商品があれば生トークンを返し、DBにはハッシュのみ保存する', async () => {
      const product = await createTestProduct('eligible');
      await prisma.productIntegrationRule.create({
        data: { productId: product.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true },
      });
      const order = await createTestOrder('eligible');
      const orderItem = await prisma.orderItem.create({
        data: { orderId: order.id, productId: product.id, productName: product.name, itemType: 'nft', quantity: 1, unitPrice: 10000, subtotal: 10000 },
      });

      const token = await prisma.$transaction((tx) => createWalletClaimIfEligible(tx, order, [orderItem]));
      expect(token).not.toBeNull();
      expect(token!.length).toBeGreaterThanOrEqual(64); // 32バイト以上の16進数文字列

      const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(claim.status).toBe('PENDING');
      expect(claim.tokenHash).toBe(hashClaimToken(token!));
      expect(claim.tokenHash).not.toBe(token);
      expect(claim.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('無効化(enabled=false)されたルールしかない場合は作成しない', async () => {
      const product = await createTestProduct('disabled-rule');
      await prisma.productIntegrationRule.create({
        data: { productId: product.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: false },
      });
      const order = await createTestOrder('disabled-rule');
      const orderItem = await prisma.orderItem.create({
        data: { orderId: order.id, productId: product.id, productName: product.name, itemType: 'nft', quantity: 1, unitPrice: 10000, subtotal: 10000 },
      });

      const token = await prisma.$transaction((tx) => createWalletClaimIfEligible(tx, order, [orderItem]));
      expect(token).toBeNull();
    });
  });
});

describe('walletClaim: reissueWalletClaimToken', () => {
  afterEach(async () => {
    await prisma.walletClaim.deleteMany({ where: { order: { orderNumber: { startsWith: ORDER_PREFIX } } } });
    await prisma.order.deleteMany({ where: { orderNumber: { startsWith: ORDER_PREFIX } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('EXPIREDのClaimは再発行でき、新しいトークンは異なるハッシュになる', async () => {
    const order = await createTestOrder('reissue-expired');
    const oldClaim = await prisma.walletClaim.create({
      data: { orderId: order.id, tokenHash: hashClaimToken('old-token'), status: 'EXPIRED', expiresAt: new Date(Date.now() - 1000) },
    });

    const newToken = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, order.id));
    expect(newToken).not.toBeNull();

    const updated = await prisma.walletClaim.findUniqueOrThrow({ where: { id: oldClaim.id } });
    expect(updated.status).toBe('PENDING');
    expect(updated.tokenHash).not.toBe(hashClaimToken('old-token'));
    expect(updated.tokenHash).toBe(hashClaimToken(newToken!));
    expect(updated.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('DELIVERY_PENDING以降のClaimは再発行できない', async () => {
    const order = await createTestOrder('reissue-in-progress');
    await prisma.walletClaim.create({
      data: {
        orderId: order.id,
        tokenHash: hashClaimToken('in-progress-token'),
        status: 'DELIVERY_PENDING',
        expiresAt: new Date(Date.now() + 1000 * 60),
      },
    });

    const newToken = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, order.id));
    expect(newToken).toBeNull();
  });

  it('REVOKEDのClaimは再発行できない', async () => {
    const order = await createTestOrder('reissue-revoked');
    await prisma.walletClaim.create({
      data: { orderId: order.id, tokenHash: hashClaimToken('revoked-token'), status: 'REVOKED', expiresAt: new Date(Date.now() + 1000 * 60) },
    });

    const newToken = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, order.id));
    expect(newToken).toBeNull();
  });

  it('存在しない注文は再発行できない', async () => {
    const newToken = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, '00000000-0000-0000-0000-000000000000'));
    expect(newToken).toBeNull();
  });
});
