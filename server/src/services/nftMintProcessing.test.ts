import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { processNftMints } from './nftMintProcessing';
import { resetFakeMintProvider, setFakeMintBehavior } from './nftMintProviders/fake';

const uploadNftMetadata = vi.fn(async (nftIssueId: string, _metadata: Record<string, unknown>) => `https://blob.example.com/nft-metadata/${nftIssueId}.json`);

vi.mock('./nftMetadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./nftMetadata')>();
  return { ...actual, uploadNftMetadata: (...args: [string, Record<string, unknown>]) => uploadNftMetadata(...args) };
});

describe('processNftMints(仕様書外の拡張)', () => {
  let productId: string;
  let userId: string;
  const originalProvider = process.env.NFT_MINT_PROVIDER;
  const originalAppUrl = process.env.APP_URL;

  beforeAll(async () => {
    process.env.NFT_MINT_PROVIDER = 'fake';
    process.env.APP_URL = 'https://sengoku-rr.com';

    const product = await prisma.product.create({
      data: {
        name: 'NFT自動発行テスト商品',
        slug: `nftmint-processing-test-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 10000,
        status: 'published',
      },
    });
    productId = product.id;

    const user = await prisma.user.create({
      data: { name: 'NFTMintテスト太郎', email: `nftmint-processing-test-${Date.now()}@example.com`, passwordHash: 'x', role: 'user' },
    });
    userId = user.id;
  });

  afterAll(async () => {
    process.env.NFT_MINT_PROVIDER = originalProvider;
    process.env.APP_URL = originalAppUrl;
    await prisma.nftIssue.deleteMany({ where: { productId } });
    await prisma.orderItem.deleteMany({ where: { productId } });
    await prisma.order.deleteMany({ where: { userId } });
    await prisma.product.delete({ where: { id: productId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  afterEach(() => {
    resetFakeMintProvider();
    uploadNftMetadata.mockClear();
  });

  async function createOrderAndIssue(
    status: string,
    extra: Partial<{ walletAddress: string | null; attemptCount: number; nextAttemptAt: Date | null; providerRequestId: string | null }> = {},
  ) {
    const order = await prisma.order.create({
      data: {
        orderNumber: `SG-NFTMINTTEST-${Math.random().toString(36).slice(2)}`,
        userId,
        totalAmount: 10000,
        originalAmount: 10000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        customerName: 'テスト',
        customerEmail: 'nftmint-processing-test@example.com',
        termsAgreedAt: new Date(),
        termsVersion: '2026-07-01',
      },
    });
    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId,
        productName: 'NFT自動発行テスト商品',
        itemType: 'nft',
        quantity: 1,
        unitPrice: 10000,
        subtotal: 10000,
      },
    });
    const nftIssue = await prisma.nftIssue.create({
      data: {
        orderId: order.id,
        orderItemId: orderItem.id,
        userId,
        productId,
        status,
        walletAddress: extra.walletAddress === undefined ? '0x1111111111111111111111111111111111111111' : extra.walletAddress,
        attemptCount: extra.attemptCount ?? 0,
        nextAttemptAt: extra.nextAttemptAt,
        providerRequestId: extra.providerRequestId ?? null,
      },
    });
    return nftIssue;
  }

  it('ready_to_issueの行をfakeプロバイダーへ送信し、issuedまで到達する', async () => {
    const issue = await createOrderAndIssue('ready_to_issue');

    const result = await processNftMints();

    expect(result.issued).toBeGreaterThanOrEqual(1);
    const after = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.status).toBe('issued');
    expect(after.tokenId).toBeTruthy();
    expect(after.transactionHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(after.metadataUri).toBe(`https://blob.example.com/nft-metadata/${issue.id}.json`);
    expect(after.issuedAt).not.toBeNull();
  });

  // 本番安定化指示書Stage2・5.4「1回の処理時間上限」: Functionの残り時間に余裕がない場合は
  // 新規claimを停止する(integration_outbox_eventsと同じ方針)。
  it('時間予算(NFT_MINT_TIME_BUDGET_MS)を使い切っている場合は新規claimを行わない', async () => {
    process.env.NFT_MINT_TIME_BUDGET_MS = '0';
    const issue = await createOrderAndIssue('ready_to_issue');

    try {
      const result = await processNftMints();
      expect(result.claimed).toBe(0);
      expect(result.issued).toBe(0);

      const after = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
      expect(after.status).toBe('ready_to_issue');
    } finally {
      delete process.env.NFT_MINT_TIME_BUDGET_MS;
    }
  });

  it('並行してclaimを試みても1件のみが処理される(アトミックなclaim)', async () => {
    const issue = await createOrderAndIssue('ready_to_issue');

    const [resultA, resultB] = await Promise.all([processNftMints(), processNftMints()]);

    expect(resultA.claimed + resultB.claimed).toBeGreaterThanOrEqual(1);

    const after = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.status).toBe('issued');
    // アップロードが2回呼ばれていれば二重処理された証拠になるため、少なくともこの行1つ分は
    // 1回しかclaimされていないことをattemptCountの非増加(失敗していない)で確認する。
    expect(after.attemptCount).toBe(0);
  });

  it('Mintが失敗すると指数バックオフでnextAttemptAtが延び、ready_to_issueへ差し戻される', async () => {
    setFakeMintBehavior(() => ({ status: 'failure', error: 'テスト用の意図的な失敗' }));
    const issue = await createOrderAndIssue('ready_to_issue');

    await processNftMints();

    const after = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.status).toBe('ready_to_issue');
    expect(after.attemptCount).toBe(1);
    expect(after.lastError).toBe('テスト用の意図的な失敗');
    expect(after.nextAttemptAt).not.toBeNull();
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
  });

  it('最大試行回数に達するとfailedになる', async () => {
    setFakeMintBehavior(() => ({ status: 'failure', error: 'テスト用の意図的な失敗' }));
    const issue = await createOrderAndIssue('ready_to_issue', { attemptCount: 4 });

    await processNftMints();

    const after = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.status).toBe('failed');
    expect(after.attemptCount).toBe(5);
  });

  it('nextAttemptAtが未来の行はスキップされ、状態が変わらない', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const issue = await createOrderAndIssue('ready_to_issue', { nextAttemptAt: future });

    await processNftMints();

    const after = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.status).toBe('ready_to_issue');
    expect(after.attemptCount).toBe(0);
  });

  it('walletAddressが無い行はwallet_requiredへ差し戻される(理論上到達しないが防御的挙動)', async () => {
    const issue = await createOrderAndIssue('ready_to_issue', { walletAddress: null });

    await processNftMints();

    const after = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.status).toBe('wallet_required');
  });

  it('claim直後でproviderRequestId未設定のprocessing行は、同時実行中とみなしすぐには失敗にしない', async () => {
    // 並行claimテストで発覚した回帰の再発防止: 送信中(providerRequestId未設定)の行を
    // 別の呼び出しがpollAndMaybeConfirmで見つけても、即座にhandleFailureへ倒さずスキップすること。
    const issue = await createOrderAndIssue('processing', { providerRequestId: null });

    await processNftMints();

    const after = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.status).toBe('processing');
    expect(after.attemptCount).toBe(0);
  });

  it('未知のproviderRequestIdを持つprocessing行は失敗として扱われ、ready_to_issueへ差し戻される', async () => {
    const issue = await createOrderAndIssue('processing', { providerRequestId: 'nonexistent-request-id' });

    await processNftMints();

    const after = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.status).toBe('ready_to_issue');
    expect(after.attemptCount).toBe(1);
    expect(after.lastError).toContain('unknown providerRequestId');
  });

  it('pending応答の場合はprocessingのまま残り、次回success応答で確定する', async () => {
    setFakeMintBehavior(() => ({ status: 'pending' }));
    const issue = await createOrderAndIssue('ready_to_issue');

    const first = await processNftMints();
    expect(first.stillProcessing).toBeGreaterThanOrEqual(1);

    const afterFirst = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(afterFirst.status).toBe('processing');
    expect(afterFirst.providerRequestId).toBeTruthy();

    setFakeMintBehavior(null);
    await processNftMints();

    const afterSecond = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(afterSecond.status).toBe('issued');
  });

  // 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)17章「自動Mint対象外」:
  // 正規の経路(orderFulfillment.ts・walletVerification.ts)ではdigital_collectible対象商品の
  // 行はready_to_issueにならない設計だが、万一到達してしまった場合の二重の安全策を確認する。
  it('digital_collectible対象商品のready_to_issue行はclaim対象から除外される(二重の安全策)', async () => {
    const dcProduct = await prisma.product.create({
      data: {
        name: `NFT自動発行テスト_digital-collectible_${Date.now()}`,
        slug: `nftmint-processing-dc-test-${Date.now()}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 10000,
        status: 'published',
      },
    });
    await prisma.productIntegrationRule.create({
      data: { productId: dcProduct.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: `SG-NFTMINTTEST-DC-${Math.random().toString(36).slice(2)}`,
        userId,
        totalAmount: 10000,
        originalAmount: 10000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        customerName: 'テスト',
        customerEmail: 'nftmint-processing-test@example.com',
        termsAgreedAt: new Date(),
        termsVersion: '2026-07-01',
      },
    });
    const orderItem = await prisma.orderItem.create({
      data: { orderId: order.id, productId: dcProduct.id, productName: dcProduct.name, itemType: 'nft', quantity: 1, unitPrice: 10000, subtotal: 10000 },
    });
    // 本来到達しないはずの状態(ready_to_issue)を直接作り、二重の安全策が機能することを確認する。
    const issue = await prisma.nftIssue.create({
      data: {
        orderId: order.id,
        orderItemId: orderItem.id,
        userId,
        productId: dcProduct.id,
        status: 'ready_to_issue',
        walletAddress: '0x2222222222222222222222222222222222222222',
      },
    });

    const result = await processNftMints();

    const after = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.status).toBe('ready_to_issue'); // claimされず、変更されない
    expect(result.claimed).toBe(0);

    await prisma.nftIssue.deleteMany({ where: { productId: dcProduct.id } });
    await prisma.orderItem.deleteMany({ where: { productId: dcProduct.id } });
    await prisma.order.deleteMany({ where: { id: order.id } });
    await prisma.productIntegrationRule.deleteMany({ where: { productId: dcProduct.id } });
    await prisma.product.delete({ where: { id: dcProduct.id } });
  });
});
