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

    it('digital_collectible対象商品があれば生トークンを返し、DBにはハッシュのみ保存する(WalletClaimItemもNftIssue単位で作成される)', async () => {
      const product = await createTestProduct('eligible');
      const rule = await prisma.productIntegrationRule.create({
        data: { productId: product.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true },
      });
      const order = await createTestOrder('eligible');
      const orderItem = await prisma.orderItem.create({
        data: { orderId: order.id, productId: product.id, productName: product.name, itemType: 'nft', quantity: 1, unitPrice: 10000, subtotal: 10000 },
      });
      // 本番の呼び出し順(orderFulfillment.ts applyPaidOrderSideEffects)ではcreateNftIssuesForOrderが
      // 先に実行され、対象NftIssue行が既に作成済みの状態でこの関数が呼ばれる。
      const nftIssue = await prisma.nftIssue.create({
        data: { orderId: order.id, orderItemId: orderItem.id, productId: product.id, status: 'wallet_required', serialNumber: 1 },
      });

      const token = await prisma.$transaction((tx) => createWalletClaimIfEligible(tx, order, [orderItem]));
      expect(token).not.toBeNull();
      expect(token!.length).toBeGreaterThanOrEqual(64); // 32バイト以上の16進数文字列

      const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(claim.status).toBe('PENDING');
      expect(claim.tokenHash).toBe(hashClaimToken(token!));
      expect(claim.tokenHash).not.toBe(token);
      expect(claim.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const claimItem = await prisma.walletClaimItem.findUniqueOrThrow({ where: { nftIssueId: nftIssue.id } });
      expect(claimItem.walletClaimId).toBe(claim.id);
      expect(claimItem.productIntegrationRuleId).toBe(rule.id);
      expect(claimItem.name).toBe(product.name);

      await prisma.walletClaimItem.deleteMany({ where: { walletClaimId: claim.id } });
      await prisma.nftIssue.deleteMany({ where: { id: nftIssue.id } });
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

  it('PENDINGのClaimも再発行でき、reissueCount・lastReissuedAtが更新される', async () => {
    const order = await createTestOrder('reissue-pending');
    const claim = await prisma.walletClaim.create({
      data: { orderId: order.id, tokenHash: hashClaimToken('pending-old-token'), status: 'PENDING', expiresAt: new Date(Date.now() + 1000 * 60) },
    });

    const newToken = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, order.id));
    expect(newToken).not.toBeNull();

    const updated = await prisma.walletClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(updated.reissueCount).toBe(1);
    expect(updated.tokenVersion).toBe(1);
    expect(updated.lastReissuedAt).not.toBeNull();
  });

  it('ERRORのClaimは再発行でき、statusがPENDINGへ戻る', async () => {
    const order = await createTestOrder('reissue-error');
    const claim = await prisma.walletClaim.create({
      data: {
        orderId: order.id,
        tokenHash: hashClaimToken('error-old-token'),
        status: 'ERROR',
        lastError: 'order not paid',
        expiresAt: new Date(Date.now() + 1000 * 60),
      },
    });

    const newToken = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, order.id));
    expect(newToken).not.toBeNull();

    const updated = await prisma.walletClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(updated.status).toBe('PENDING');
    expect(updated.lastError).toBeNull();
  });

  it('CLAIMEDのClaimは再発行できない', async () => {
    const order = await createTestOrder('reissue-claimed');
    await prisma.walletClaim.create({
      data: { orderId: order.id, tokenHash: hashClaimToken('claimed-token'), status: 'CLAIMED', expiresAt: new Date(Date.now() + 1000 * 60) },
    });

    const newToken = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, order.id));
    expect(newToken).toBeNull();
  });

  // Wallet Claim本番前安定化指示書(2026-07-25)Phase1「必須テスト: 同時再発行2件」:
  // Promise.allでの見かけ上の同時実行だけでは、実際のSQL発行タイミングが重ならず両方成功して
  // しまうことがある(真の競合を再現できない)ため、「古い読み取り時点のtoken_hashを条件とした
  // 更新が、既に別プロセスによって書き換えられた後は失敗する」というCAS自体の保証を直接検証する。
  it('古いtoken_hashを条件とした再発行の条件付き更新は、既に別プロセスが再発行した後は失敗する(楽観ロック)', async () => {
    const order = await createTestOrder('reissue-concurrent');
    const claim = await prisma.walletClaim.create({
      data: { orderId: order.id, tokenHash: hashClaimToken('concurrent-old-token'), status: 'PENDING', expiresAt: new Date(Date.now() + 1000 * 60) },
    });

    // 「同時に読み取った古いスナップショット」を模擬する。
    const staleSnapshot = await prisma.walletClaim.findUniqueOrThrow({ where: { id: claim.id } });

    // 先に1件目の再発行が正常に成功する(token_hashが書き換わる)。
    const firstToken = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, order.id));
    expect(firstToken).not.toBeNull();

    // 古いスナップショット(既に無効化されたtoken_hash)を条件にした2件目の更新試行は失敗する。
    const staleUpdate = await prisma.walletClaim.updateMany({
      where: { id: staleSnapshot.id, tokenHash: staleSnapshot.tokenHash, status: staleSnapshot.status },
      data: { tokenHash: hashClaimToken('stale-writer-token'), status: 'PENDING' },
    });
    expect(staleUpdate.count).toBe(0);

    const updated = await prisma.walletClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(updated.tokenHash).toBe(hashClaimToken(firstToken!));
    expect(updated.reissueCount).toBe(1);
  });

  // 最終安定化指示書Phase2「Notification Tokenの安定化」
  describe('notificationEventId指定時(決定論的発行)', () => {
    const originalSecret = process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET;

    afterEach(() => {
      if (originalSecret === undefined) delete process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET;
      else process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET = originalSecret;
    });

    it('同一notification_event_idでの再試行はrotateせず同じTokenを返す(reissueCountも増えない)', async () => {
      process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET = 'b'.repeat(32);
      const order = await createTestOrder('reissue-deterministic-retry');
      const claim = await prisma.walletClaim.create({
        data: { orderId: order.id, tokenHash: hashClaimToken('old-token'), status: 'PENDING', expiresAt: new Date(Date.now() + 1000 * 60) },
      });

      const first = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, order.id, 'notif-evt-1'));
      const second = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, order.id, 'notif-evt-1'));

      expect(first).not.toBeNull();
      expect(second).toBe(first);

      const updated = await prisma.walletClaim.findUniqueOrThrow({ where: { id: claim.id } });
      expect(updated.tokenHash).toBe(hashClaimToken(first!));
      expect(updated.reissueCount).toBe(1); // 2回目は同一Tokenの再確認のみでrotateしない
    });

    it('異なるnotification_event_id(=新しい再発行要求)は別のTokenへrotateする', async () => {
      process.env.NOTIFICATION_TOKEN_DERIVATION_SECRET = 'b'.repeat(32);
      const order = await createTestOrder('reissue-deterministic-newevent');
      await prisma.walletClaim.create({
        data: { orderId: order.id, tokenHash: hashClaimToken('old-token'), status: 'PENDING', expiresAt: new Date(Date.now() + 1000 * 60) },
      });

      const first = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, order.id, 'notif-evt-a'));
      const second = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, order.id, 'notif-evt-b'));

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(second).not.toBe(first);

      const updated = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
      expect(updated.reissueCount).toBe(2);
    });
  });
});
