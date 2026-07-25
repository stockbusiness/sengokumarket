import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { applyPaidOrderSideEffects } from './orderFulfillment';
import { hashClaimToken } from './walletClaim';

const PRODUCT_PREFIX = 'order-fulfillment-test-product-';
const ORDER_PREFIX = 'SG-FULFILLTEST-';

async function createDigitalCollectibleProduct(suffix: string) {
  const product = await prisma.product.create({
    data: {
      name: `${PRODUCT_PREFIX}${suffix}`,
      slug: `${PRODUCT_PREFIX}${suffix}`,
      category: 'テスト',
      itemType: 'nft',
      basePrice: 10000,
      status: 'published',
    },
  });
  await prisma.productIntegrationRule.create({
    data: { productId: product.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true },
  });
  return product;
}

async function createOrderWithItem(productId: string, suffix: string, quantity: number) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `${ORDER_PREFIX}${suffix}`,
      totalAmount: 10000 * quantity,
      originalAmount: 10000 * quantity,
      paymentStatus: 'paid',
      orderStatus: 'paid',
      customerName: '発行テスト太郎',
      customerEmail: `fulfill-test-${suffix}@example.com`,
      termsAgreedAt: new Date(),
      termsVersion: '2026-07-01',
    },
  });
  const orderItem = await prisma.orderItem.create({
    data: { orderId: order.id, productId, productName: 'test', itemType: 'nft', quantity, unitPrice: 10000, subtotal: 10000 * quantity },
  });
  return { order, orderItem };
}

async function cleanup(orderId: string, productId: string) {
  await prisma.walletClaim.deleteMany({ where: { orderId } });
  await prisma.nftIssue.deleteMany({ where: { orderId } });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
  await prisma.productIntegrationRule.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
}

describe('orderFulfillment: applyPaidOrderSideEffects (digital_collectible: serialNumber・WalletClaim)', () => {
  const originalFlag = process.env.ENABLE_WALLET_CLAIM;

  beforeEach(() => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
  });

  afterEach(() => {
    process.env.ENABLE_WALLET_CLAIM = originalFlag;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('quantity=2のdigital_collectible対象商品は、2件のNftIssue(重複しないserialNumber)とWalletClaim(PENDING)を同一トランザクションで作成する', async () => {
    const product = await createDigitalCollectibleProduct('qty2');
    const { order, orderItem } = await createOrderWithItem(product.id, 'qty2', 2);

    const result = await prisma.$transaction((tx) => applyPaidOrderSideEffects(tx, order));

    expect(result.walletClaimToken).not.toBeNull();

    const nftIssues = await prisma.nftIssue.findMany({ where: { orderItemId: orderItem.id }, orderBy: { serialNumber: 'asc' } });
    expect(nftIssues).toHaveLength(2);
    expect(nftIssues.map((n) => n.serialNumber)).toEqual([1, 2]);

    const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(claim.status).toBe('PENDING');
    expect(claim.tokenHash).toBe(hashClaimToken(result.walletClaimToken!));

    await cleanup(order.id, product.id);
  });

  it('digital_collectible対象外のNFT商品はserialNumberがnullのまま(既存挙動を変えない)・WalletClaimも作成しない', async () => {
    const product = await prisma.product.create({
      data: {
        name: `${PRODUCT_PREFIX}no-rule`,
        slug: `${PRODUCT_PREFIX}no-rule`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 10000,
        status: 'published',
      },
    });
    const { order, orderItem } = await createOrderWithItem(product.id, 'no-rule', 1);

    const result = await prisma.$transaction((tx) => applyPaidOrderSideEffects(tx, order));

    expect(result.walletClaimToken).toBeNull();
    const nftIssues = await prisma.nftIssue.findMany({ where: { orderItemId: orderItem.id } });
    expect(nftIssues).toHaveLength(1);
    expect(nftIssues[0].serialNumber).toBeNull();

    await cleanup(order.id, product.id);
  });

  it('商品ごとのシリアル番号は注文をまたいでも重複しない', async () => {
    const product = await createDigitalCollectibleProduct('cross-order');
    const { order: order1, orderItem: item1 } = await createOrderWithItem(product.id, 'cross-order-1', 1);
    await prisma.$transaction((tx) => applyPaidOrderSideEffects(tx, order1));

    const { order: order2, orderItem: item2 } = await createOrderWithItem(product.id, 'cross-order-2', 1);
    await prisma.$transaction((tx) => applyPaidOrderSideEffects(tx, order2));

    const issue1 = await prisma.nftIssue.findFirstOrThrow({ where: { orderItemId: item1.id } });
    const issue2 = await prisma.nftIssue.findFirstOrThrow({ where: { orderItemId: item2.id } });
    expect(issue1.serialNumber).toBe(1);
    expect(issue2.serialNumber).toBe(2);

    await prisma.walletClaim.deleteMany({ where: { orderId: { in: [order1.id, order2.id] } } });
    await prisma.nftIssue.deleteMany({ where: { orderId: { in: [order1.id, order2.id] } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: [order1.id, order2.id] } } });
    await prisma.order.deleteMany({ where: { id: { in: [order1.id, order2.id] } } });
    await prisma.productIntegrationRule.deleteMany({ where: { productId: product.id } });
    await prisma.product.deleteMany({ where: { id: product.id } });
  });
});
