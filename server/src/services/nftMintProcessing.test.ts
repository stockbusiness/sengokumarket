import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { processNftMints, submitAndMaybeConfirm } from './nftMintProcessing';
import { fakeMintProvider, resetFakeMintProvider, setFakeMintBehavior } from './nftMintProviders/fake';

async function claimToProcessing(issueId: string) {
  await prisma.$executeRaw`UPDATE nft_issues SET status = 'processing', updated_at = now() WHERE id = ${issueId}::uuid`;
}

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

  // 仕様書外の拡張(運営手動Mint): cronはready_to_issueの行を自動claimしなくなったため、
  // submitAndMaybeConfirmは呼び出し元(管理画面API)がprocessingへclaimした後に直接呼ぶ想定。
  it('claim後にsubmitAndMaybeConfirmを呼ぶと、fakeプロバイダーへ送信されissuedまで到達しserialNumberが保存される', async () => {
    const issue = await createOrderAndIssue('ready_to_issue');
    await claimToProcessing(issue.id);

    const result = { claimed: 1, issued: 0, stillProcessing: 0, retrying: 0, failed: 0, skipped: 0 };
    await submitAndMaybeConfirm(issue.id, fakeMintProvider, result, 7);

    expect(result.issued).toBe(1);
    const after = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.status).toBe('issued');
    expect(after.tokenId).toBeTruthy();
    expect(after.transactionHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(after.metadataUri).toBe(`https://blob.example.com/nft-metadata/${issue.id}.json`);
    expect(after.issuedAt).not.toBeNull();
    expect(after.serialNumber).toBe(7);
  });

  it('serialNumberが同一商品内で重複する場合はready_to_issueへ差し戻され、SERIAL_NUMBER_DUPLICATEエラーになる', async () => {
    const issueA = await createOrderAndIssue('ready_to_issue');
    await claimToProcessing(issueA.id);
    const result = { claimed: 1, issued: 0, stillProcessing: 0, retrying: 0, failed: 0, skipped: 0 };
    await submitAndMaybeConfirm(issueA.id, fakeMintProvider, result, 42);

    const issueB = await createOrderAndIssue('ready_to_issue');
    await claimToProcessing(issueB.id);

    await expect(submitAndMaybeConfirm(issueB.id, fakeMintProvider, result, 42)).rejects.toMatchObject({
      code: 'SERIAL_NUMBER_DUPLICATE',
    });
    const after = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issueB.id } });
    expect(after.status).toBe('ready_to_issue');
  });

  it('Mintが失敗すると指数バックオフでnextAttemptAtが延び、ready_to_issueへ差し戻される', async () => {
    setFakeMintBehavior(() => ({ status: 'failure', error: 'テスト用の意図的な失敗' }));
    const issue = await createOrderAndIssue('ready_to_issue');
    await claimToProcessing(issue.id);

    const result = { claimed: 1, issued: 0, stillProcessing: 0, retrying: 0, failed: 0, skipped: 0 };
    await submitAndMaybeConfirm(issue.id, fakeMintProvider, result, 501);

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
    await claimToProcessing(issue.id);

    const result = { claimed: 1, issued: 0, stillProcessing: 0, retrying: 0, failed: 0, skipped: 0 };
    await submitAndMaybeConfirm(issue.id, fakeMintProvider, result, 502);

    const after = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.status).toBe('failed');
    expect(after.attemptCount).toBe(5);
  });

  it('walletAddressが無い行はwallet_requiredへ差し戻される(理論上到達しないが防御的挙動)', async () => {
    const issue = await createOrderAndIssue('ready_to_issue', { walletAddress: null });
    await claimToProcessing(issue.id);

    const result = { claimed: 1, issued: 0, stillProcessing: 0, retrying: 0, failed: 0, skipped: 0 };
    await submitAndMaybeConfirm(issue.id, fakeMintProvider, result, 503);

    const after = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.status).toBe('wallet_required');
  });

  it('processNftMintsはready_to_issueの行を自動claimしない(運営手動Mintへの移行)', async () => {
    const issue = await createOrderAndIssue('ready_to_issue');

    const result = await processNftMints();

    expect(result.claimed).toBe(0);
    expect(result.issued).toBe(0);
    const after = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(after.status).toBe('ready_to_issue');
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
    await claimToProcessing(issue.id);

    const submitResult = { claimed: 1, issued: 0, stillProcessing: 0, retrying: 0, failed: 0, skipped: 0 };
    await submitAndMaybeConfirm(issue.id, fakeMintProvider, submitResult, 504);
    expect(submitResult.stillProcessing).toBe(1);

    const afterFirst = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(afterFirst.status).toBe('processing');
    expect(afterFirst.providerRequestId).toBeTruthy();

    setFakeMintBehavior(null);
    await processNftMints();

    const afterSecond = await prisma.nftIssue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(afterSecond.status).toBe('issued');
  });
});
