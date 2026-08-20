import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const uploadNftMetadata = vi.fn(async (nftIssueId: string, _metadata: Record<string, unknown>) => `https://blob.example.com/nft-metadata/${nftIssueId}.json`);

vi.mock('../../services/nftMetadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/nftMetadata')>();
  return { ...actual, uploadNftMetadata: (...args: [string, Record<string, unknown>]) => uploadNftMetadata(...args) };
});

const app = createApp();
const VALID_TX_HASH = `0x${'a'.repeat(64)}`;

describe('管理API: NFT発行管理', () => {
  let productId: string;
  let nftIssueId: string;

  beforeAll(async () => {
    const product = await prisma.product.create({
      data: {
        name: 'admin-nft-test商品',
        slug: `admin-nft-test-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 10000,
        status: 'published',
      },
    });
    productId = product.id;
    const variant = await prisma.productVariant.create({
      data: { productId, name: 'A', price: 10000, stock: 5 },
    });

    const order = await prisma.order.create({
      data: {
        orderNumber: `SG-NFTADMIN-${Date.now()}`,
        totalAmount: 10000,
        originalAmount: 10000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        customerName: 'テスト',
        customerEmail: 'admin-nft-test@example.com',
        termsAgreedAt: new Date(),
        termsVersion: '2026-07-01',
      },
    });
    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId,
        variantId: variant.id,
        productName: product.name,
        variantName: variant.name,
        itemType: 'nft',
        quantity: 1,
        unitPrice: 10000,
        subtotal: 10000,
      },
    });
    const nftIssue = await prisma.nftIssue.create({
      data: { orderId: order.id, orderItemId: orderItem.id, productId, variantId: variant.id, status: 'ready_to_issue' },
    });
    nftIssueId = nftIssue.id;
  });

  afterAll(async () => {
    await prisma.nftIssue.deleteMany({ where: { productId } });
    await prisma.orderItem.deleteMany({ where: { productId } });
    await prisma.order.deleteMany({ where: { customerEmail: 'admin-nft-test@example.com' } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('token_id / transaction_hashなしでissuedに変更しようとすると400', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.put(`/api/admin/nft-issues/${nftIssueId}`).set('Origin', TEST_ORIGIN).send({ status: 'issued' });
    expect(res.status).toBe(400);
  });

  it('不正な形式のtransaction_hashは400', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .put(`/api/admin/nft-issues/${nftIssueId}`)
      .set('Origin', TEST_ORIGIN)
      .send({ status: 'issued', tokenId: '1', transactionHash: '0xshort' });
    expect(res.status).toBe(400);
  });

  it('token_id / transaction_hashを指定するとissuedになりissued_atが記録される', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .put(`/api/admin/nft-issues/${nftIssueId}`)
      .set('Origin', TEST_ORIGIN)
      .send({ status: 'issued', tokenId: '42', transactionHash: VALID_TX_HASH });

    expect(res.status).toBe(200);
    expect(res.body.nftIssue.status).toBe('issued');
    expect(res.body.nftIssue.issuedAt).not.toBeNull();

    const persisted = await prisma.nftIssue.findUniqueOrThrow({ where: { id: nftIssueId } });
    expect(persisted.tokenId).toBe('42');
  });

  it('statusでフィルタできる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/nft-issues').query({ status: 'issued' });
    expect(res.status).toBe(200);
    expect(res.body.nftIssues.some((n: { id: string }) => n.id === nftIssueId)).toBe(true);
  });

  it('一覧はページネーション情報(page/pageSize/total)を返す(仕様書外の拡張・保守性改善Phase8)', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/nft-issues');
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(typeof res.body.pageSize).toBe('number');
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  describe('不正な状態遷移の拒否(仕様書外の拡張・保守性改善Phase6)', () => {
    it('issued→wallet_requiredは409を返す(指示書が挙げる不正遷移の例)', async () => {
      const { agent } = await createAdminAgent(app);
      const res = await agent
        .put(`/api/admin/nft-issues/${nftIssueId}`)
        .set('Origin', TEST_ORIGIN)
        .send({ status: 'wallet_required' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_NFT_ISSUE_STATUS_TRANSITION');

      const persisted = await prisma.nftIssue.findUniqueOrThrow({ where: { id: nftIssueId } });
      expect(persisted.status).toBe('issued');
    });
  });

  describe('再試行・保留(仕様書外の拡張・NFT自動発行)', () => {
    let productId2: string;

    async function createIssue(status: string, extra: Partial<{ attemptCount: number; nextAttemptAt: Date }> = {}) {
      const order = await prisma.order.create({
        data: {
          orderNumber: `SG-NFTADMINRETRY-${Math.random().toString(36).slice(2)}`,
          totalAmount: 10000,
          originalAmount: 10000,
          paymentStatus: 'paid',
          orderStatus: 'paid',
          customerName: 'テスト',
          customerEmail: 'admin-nft-test-retry@example.com',
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
        },
      });
      const orderItem = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: productId2,
          productName: 'テスト',
          itemType: 'nft',
          quantity: 1,
          unitPrice: 10000,
          subtotal: 10000,
        },
      });
      return prisma.nftIssue.create({
        data: {
          orderId: order.id,
          orderItemId: orderItem.id,
          productId: productId2,
          status,
          attemptCount: extra.attemptCount ?? 0,
          nextAttemptAt: extra.nextAttemptAt ?? null,
        },
      });
    }

    beforeAll(async () => {
      const product = await prisma.product.create({
        data: {
          name: 'admin-nft-retry-test商品',
          slug: `admin-nft-retry-test-${Date.now()}`,
          category: 'テスト',
          itemType: 'nft',
          basePrice: 10000,
          status: 'published',
        },
      });
      productId2 = product.id;
    });

    afterAll(async () => {
      await prisma.nftIssue.deleteMany({ where: { productId: productId2 } });
      await prisma.orderItem.deleteMany({ where: { productId: productId2 } });
      await prisma.order.deleteMany({ where: { customerEmail: 'admin-nft-test-retry@example.com' } });
      await prisma.product.delete({ where: { id: productId2 } });
    });

    it('failedの行を再試行するとready_to_issueに戻りnextAttemptAtがクリアされる', async () => {
      const issue = await createIssue('failed', { attemptCount: 5, nextAttemptAt: new Date(Date.now() + 60_000) });
      const { agent } = await createAdminAgent(app);

      const res = await agent.post(`/api/admin/nft-issues/${issue.id}/retry`).set('Origin', TEST_ORIGIN);
      expect(res.status).toBe(200);
      expect(res.body.nftIssue.status).toBe('ready_to_issue');
      expect(res.body.nftIssue.nextAttemptAt).toBeNull();
    });

    it('issued/cancelledの行は再試行できず400を返す', async () => {
      const issue = await createIssue('cancelled');
      const { agent } = await createAdminAgent(app);

      const res = await agent.post(`/api/admin/nft-issues/${issue.id}/retry`).set('Origin', TEST_ORIGIN);
      expect(res.status).toBe(400);
    });

    it('ready_to_issueの行を保留にするとnextAttemptAtが遠い未来に設定される', async () => {
      const issue = await createIssue('ready_to_issue');
      const { agent } = await createAdminAgent(app);

      const res = await agent.post(`/api/admin/nft-issues/${issue.id}/hold`).set('Origin', TEST_ORIGIN);
      expect(res.status).toBe(200);
      expect(res.body.nftIssue.status).toBe('ready_to_issue');
      expect(new Date(res.body.nftIssue.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + 365 * 24 * 60 * 60 * 1000);
    });

    it('存在しないIDへの再試行・保留は404を返す', async () => {
      const { agent } = await createAdminAgent(app);
      const retryRes = await agent.post('/api/admin/nft-issues/00000000-0000-0000-0000-000000000000/retry').set('Origin', TEST_ORIGIN);
      expect(retryRes.status).toBe(404);
      const holdRes = await agent.post('/api/admin/nft-issues/00000000-0000-0000-0000-000000000000/hold').set('Origin', TEST_ORIGIN);
      expect(holdRes.status).toBe(404);
    });
  });

  describe('運営手動Mint(仕様書外の拡張・自動Mint→手動Mintへの移行)', () => {
    let productId3: string;
    const originalProvider = process.env.NFT_MINT_PROVIDER;

    beforeAll(async () => {
      process.env.NFT_MINT_PROVIDER = 'fake';
      const product = await prisma.product.create({
        data: {
          name: 'admin-nft-mint-test商品',
          slug: `admin-nft-mint-test-${Date.now()}`,
          category: 'テスト',
          itemType: 'nft',
          basePrice: 10000,
          status: 'published',
        },
      });
      productId3 = product.id;
    });

    afterAll(async () => {
      process.env.NFT_MINT_PROVIDER = originalProvider;
      await prisma.nftIssue.deleteMany({ where: { productId: productId3 } });
      await prisma.orderItem.deleteMany({ where: { productId: productId3 } });
      await prisma.order.deleteMany({ where: { customerEmail: 'admin-nft-test-mint@example.com' } });
      await prisma.productIntegrationRule.deleteMany({ where: { productId: productId3 } });
      await prisma.product.delete({ where: { id: productId3 } });
    });

    async function createMintableIssue(
      overrides: Partial<{ status: string; nextAttemptAt: Date | null; walletAddress: string | null }> = {},
    ) {
      const order = await prisma.order.create({
        data: {
          orderNumber: `SG-NFTADMINMINT-${Math.random().toString(36).slice(2)}`,
          totalAmount: 10000,
          originalAmount: 10000,
          paymentStatus: 'paid',
          orderStatus: 'paid',
          customerName: 'テスト',
          customerEmail: 'admin-nft-test-mint@example.com',
          termsAgreedAt: new Date(),
          termsVersion: '2026-07-01',
        },
      });
      const orderItem = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: productId3,
          productName: 'テスト',
          itemType: 'nft',
          quantity: 1,
          unitPrice: 10000,
          subtotal: 10000,
        },
      });
      return prisma.nftIssue.create({
        data: {
          orderId: order.id,
          orderItemId: orderItem.id,
          productId: productId3,
          status: overrides.status ?? 'ready_to_issue',
          nextAttemptAt: overrides.nextAttemptAt ?? null,
          walletAddress: overrides.walletAddress === undefined ? '0x3333333333333333333333333333333333333333' : overrides.walletAddress,
        },
      });
    }

    it('ready_to_issueの行にシリアル番号を指定して発行するとissuedになりserialNumberが保存される', async () => {
      const issue = await createMintableIssue();
      const { agent } = await createAdminAgent(app);

      const res = await agent.post(`/api/admin/nft-issues/${issue.id}/mint`).set('Origin', TEST_ORIGIN).send({ serialNumber: 3 });

      expect(res.status).toBe(200);
      expect(res.body.nftIssue.status).toBe('issued');
      const persisted = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
      expect(persisted.serialNumber).toBe(3);
    });

    it('シリアル番号を指定しない、または0以下の場合は400を返す', async () => {
      const issue = await createMintableIssue();
      const { agent } = await createAdminAgent(app);

      const res = await agent.post(`/api/admin/nft-issues/${issue.id}/mint`).set('Origin', TEST_ORIGIN).send({ serialNumber: 0 });
      expect(res.status).toBe(400);
    });

    it('同一商品内でシリアル番号が重複すると400を返し、ready_to_issueのまま残る', async () => {
      const issueA = await createMintableIssue();
      const { agent } = await createAdminAgent(app);
      await agent.post(`/api/admin/nft-issues/${issueA.id}/mint`).set('Origin', TEST_ORIGIN).send({ serialNumber: 10 });

      const issueB = await createMintableIssue();
      const res = await agent.post(`/api/admin/nft-issues/${issueB.id}/mint`).set('Origin', TEST_ORIGIN).send({ serialNumber: 10 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('SERIAL_NUMBER_DUPLICATE');
      const persisted = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issueB.id } });
      expect(persisted.status).toBe('ready_to_issue');
    });

    it('ready_to_issue以外の行への発行は400を返す', async () => {
      const issue = await createMintableIssue({ status: 'wallet_required', walletAddress: null });
      const { agent } = await createAdminAgent(app);

      const res = await agent.post(`/api/admin/nft-issues/${issue.id}/mint`).set('Origin', TEST_ORIGIN).send({ serialNumber: 1 });
      expect(res.status).toBe(400);
    });

    it('保留中(nextAttemptAtが未来)の行への発行は400を返す', async () => {
      const issue = await createMintableIssue({ nextAttemptAt: new Date(Date.now() + 60_000) });
      const { agent } = await createAdminAgent(app);

      const res = await agent.post(`/api/admin/nft-issues/${issue.id}/mint`).set('Origin', TEST_ORIGIN).send({ serialNumber: 1 });
      expect(res.status).toBe(400);
    });

    // 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)17章「自動Mint対象外」:
    // digital_collectible対象商品は別経路(WalletClaim)で送付するため、本来この状態には
    // 到達しないはずだが、二重の安全策としてこの画面からの発行も拒否する。
    it('digital_collectible対象商品の行への発行は拒否される(二重の安全策)', async () => {
      await prisma.productIntegrationRule.create({
        data: { productId: productId3, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true },
      });
      try {
        const issue = await createMintableIssue();
        const { agent } = await createAdminAgent(app);

        const res = await agent.post(`/api/admin/nft-issues/${issue.id}/mint`).set('Origin', TEST_ORIGIN).send({ serialNumber: 99 });
        expect(res.status).toBe(400);
        const persisted = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
        expect(persisted.status).toBe('ready_to_issue');
      } finally {
        await prisma.productIntegrationRule.deleteMany({ where: { productId: productId3 } });
      }
    });

    it('存在しないIDへの発行は404を返す', async () => {
      const { agent } = await createAdminAgent(app);
      const res = await agent.post('/api/admin/nft-issues/00000000-0000-0000-0000-000000000000/mint').set('Origin', TEST_ORIGIN).send({ serialNumber: 1 });
      expect(res.status).toBe(404);
    });

    it('一覧のready_to_issue行にはsuggestedSerialNumberが含まれる', async () => {
      const issue = await createMintableIssue();
      const { agent } = await createAdminAgent(app);

      const res = await agent.get('/api/admin/nft-issues').query({ status: 'ready_to_issue' });
      expect(res.status).toBe(200);
      const row = res.body.nftIssues.find((n: { id: string }) => n.id === issue.id);
      expect(row).toBeTruthy();
      expect(typeof row.suggestedSerialNumber).toBe('number');
    });
  });
});
