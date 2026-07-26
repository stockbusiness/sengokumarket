import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { setSetting } from '../../services/settings';
import { buildSennokuniHeaders } from '../../lib/sennokuniHmac';
import { hashClaimToken } from '../../services/walletClaim';
import { setSennokuniIntegrationStageSetting } from '../../services/sennokuniIntegrationConfig';
import { dispatchPendingOutboxEvents } from '../../services/integrationOutboxDispatcher';

const app = createApp();
const KEY_ID = 'wallet-claim-test-key';
const SECRET = 'wallet-claim-test-secret';
const ORDER_PREFIX = 'SG-WCROUTETEST-';
const PRODUCT_PREFIX = 'wallet-claim-route-test-product-';

function signedHeaders(input: { method: string; path: string; rawBody: string; timestamp?: string; nonce?: string; idempotencyKey?: string }) {
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? crypto.randomBytes(8).toString('hex');
  const idempotencyKey = input.idempotencyKey ?? crypto.randomBytes(8).toString('hex');
  const headers = buildSennokuniHeaders({
    keyId: KEY_ID,
    secret: SECRET,
    timestamp,
    nonce,
    method: input.method,
    path: input.path,
    rawBody: input.rawBody,
    idempotencyKey,
  });
  return headers;
}

async function createEligibleOrderWithClaim(suffix: string, token: string) {
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
  const rule = await prisma.productIntegrationRule.create({
    data: { productId: product.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `${ORDER_PREFIX}${suffix}`,
      totalAmount: 10000,
      originalAmount: 10000,
      paymentStatus: 'paid',
      orderStatus: 'paid',
      customerName: 'ルートテスト太郎',
      customerEmail: `wc-route-test-${suffix}@example.com`,
      termsAgreedAt: new Date(),
      termsVersion: '2026-07-01',
      commonUserId: 'cu_test_00000001',
      commonUserResolutionStatus: 'resolved',
    },
  });
  const orderItem = await prisma.orderItem.create({
    data: { orderId: order.id, productId: product.id, productName: product.name, itemType: 'nft', quantity: 1, unitPrice: 10000, subtotal: 10000 },
  });
  const nftIssue = await prisma.nftIssue.create({
    data: { orderId: order.id, orderItemId: orderItem.id, productId: product.id, status: 'wallet_required', serialNumber: 1 },
  });
  const claim = await prisma.walletClaim.create({
    data: { orderId: order.id, tokenHash: hashClaimToken(token), status: 'PENDING', expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) },
  });
  // Wallet Claim本番前安定化指示書(2026-07-25)Phase4: confirmWalletClaimは決済確定時に作成される
  // WalletClaimItemを基準に判断するため、このテスト用ヘルパーでも同時に作成する。
  await prisma.walletClaimItem.create({
    data: {
      walletClaimId: claim.id,
      nftIssueId: nftIssue.id,
      orderItemId: orderItem.id,
      productId: product.id,
      productIntegrationRuleId: rule.id,
      destinationSystemKey: rule.entitlementTargetSystemKey!,
      entitlementType: rule.entitlementType!,
      name: product.name,
    },
  });
  return { product, order };
}

async function cleanupOrder(orderId: string, productId: string) {
  const deliveries = await prisma.collectibleDelivery.findMany({ where: { walletClaim: { orderId } } });
  const outboxEventIds = deliveries.map((d) => d.outboxEventId).filter((id): id is string => !!id);
  await prisma.collectibleDelivery.deleteMany({ where: { walletClaim: { orderId } } });
  await prisma.integrationEventAttempt.deleteMany({ where: { outboxEventId: { in: outboxEventIds } } });
  await prisma.integrationOutboxEvent.deleteMany({ where: { id: { in: outboxEventIds } } });
  await prisma.walletClaimAuditLog.deleteMany({ where: { orderId } });
  await prisma.walletClaimItem.deleteMany({ where: { walletClaim: { orderId } } });
  await prisma.walletClaim.deleteMany({ where: { orderId } });
  await prisma.nftIssue.deleteMany({ where: { orderId } });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
  await prisma.productIntegrationRule.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
}

describe('GET/POST /api/integrations/wallet-claims (HMAC認証)', () => {
  const originalFlag = process.env.ENABLE_WALLET_CLAIM;

  beforeAll(async () => {
    await setSetting('wallet_claim_inbound_key_id', KEY_ID);
    await setSetting('wallet_claim_inbound_hmac_secret', SECRET);
  });

  beforeEach(() => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
  });

  afterEach(async () => {
    process.env.ENABLE_WALLET_CLAIM = originalFlag;
    await prisma.rateLimitBucket.deleteMany({ where: { bucketKey: { contains: 'wallet-claim-integration' } } });
  });

  afterAll(async () => {
    await prisma.setting.deleteMany({ where: { key: { in: ['wallet_claim_inbound_key_id', 'wallet_claim_inbound_hmac_secret'] } } });
    await prisma.$disconnect();
  });

  it('ENABLE_WALLET_CLAIM=falseの間は認証情報があっても503を返す', async () => {
    delete process.env.ENABLE_WALLET_CLAIM;
    const path = '/api/integrations/wallet-claims/some-token';
    const headers = signedHeaders({ method: 'GET', path, rawBody: '' });
    const res = await request(app).get(path).set(headers);
    expect(res.status).toBe(503);
  });

  it('認証ヘッダーが不足している場合401', async () => {
    const res = await request(app).get('/api/integrations/wallet-claims/some-token');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it('署名が不正な場合401', async () => {
    const path = '/api/integrations/wallet-claims/some-token';
    const headers = signedHeaders({ method: 'GET', path, rawBody: '' });
    headers['X-SenNoKuni-Signature'] = 'a'.repeat(64);
    const res = await request(app).get(path).set(headers);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
  });

  // Wallet Claim本番前安定化指示書(2026-07-25)Phase2「必須処理順序」: 署名検証より前にnonceを
  // INSERTしない。無効署名のリクエストでnonce行が消費されないため、同じnonceを正しい署名で
  // 再利用できることを確認する。
  it('無効な署名のリクエストはnonceを消費しない(同じnonceを正しい署名で再利用できる)', async () => {
    const path = '/api/integrations/wallet-claims/some-token';
    const nonce = crypto.randomBytes(8).toString('hex');
    const invalidHeaders = signedHeaders({ method: 'GET', path, rawBody: '', nonce });
    invalidHeaders['X-SenNoKuni-Signature'] = 'a'.repeat(64);
    const invalidRes = await request(app).get(path).set(invalidHeaders);
    expect(invalidRes.status).toBe(401);
    expect(invalidRes.body.error.code).toBe('INVALID_SIGNATURE');

    const validHeaders = signedHeaders({ method: 'GET', path, rawBody: '', nonce });
    const validRes = await request(app).get(path).set(validHeaders);
    expect(validRes.status).toBe(404); // 認証は通る(トークン自体が存在しないだけ)
  });

  it('ヘッダーが上限長を超える場合400', async () => {
    const path = '/api/integrations/wallet-claims/some-token';
    const headers = signedHeaders({ method: 'GET', path, rawBody: '' });
    headers['X-SenNoKuni-Key-Id'] = 'k'.repeat(200);
    const res = await request(app).get(path).set(headers);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('HEADER_TOO_LONG');
  });

  it('DB障害(P2002以外のエラー)はnonce再利用と誤判定せず500として伝播する', async () => {
    const path = '/api/integrations/wallet-claims/some-token';
    const headers = signedHeaders({ method: 'GET', path, rawBody: '' });

    const spy = vi.spyOn(prisma.walletClaimApiNonce, 'create').mockRejectedValueOnce(new Error('connection refused'));
    const res = await request(app).get(path).set(headers);
    expect(res.status).toBe(500);
    spy.mockRestore();
  });

  it('timestampが許容範囲外の場合401', async () => {
    const path = '/api/integrations/wallet-claims/some-token';
    const oldTimestamp = String(Math.floor(Date.now() / 1000) - 60 * 60);
    const headers = signedHeaders({ method: 'GET', path, rawBody: '', timestamp: oldTimestamp });
    const res = await request(app).get(path).set(headers);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TIMESTAMP_OUT_OF_RANGE');
  });

  it('同じnonceを2回使うと2回目は401(リプレイ拒否)', async () => {
    const path = '/api/integrations/wallet-claims/some-token';
    const nonce = crypto.randomBytes(8).toString('hex');
    const headers1 = signedHeaders({ method: 'GET', path, rawBody: '', nonce });
    const res1 = await request(app).get(path).set(headers1);
    expect(res1.status).toBe(404); // 認証は通るがトークン自体は存在しない

    const headers2 = signedHeaders({ method: 'GET', path, rawBody: '', nonce });
    const res2 = await request(app).get(path).set(headers2);
    expect(res2.status).toBe(401);
    expect(res2.body.error.code).toBe('NONCE_REUSED');
  });

  it('正しい署名でGET状態確認・POST確認(common_user_id一致)が成功する(quantity=1のDelivery/Outboxが作成される)', async () => {
    const token = 'wc-route-happy-path-token';
    const { order, product } = await createEligibleOrderWithClaim('happy', token);

    const statusPath = `/api/integrations/wallet-claims/${token}`;
    const statusHeaders = signedHeaders({ method: 'GET', path: statusPath, rawBody: '' });
    const statusRes = await request(app).get(statusPath).set(statusHeaders);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('PENDING');

    const confirmPath = `/api/integrations/wallet-claims/${token}/confirm`;
    const body = JSON.stringify({ ove_account_id: 'ove-acc-1', common_user_id: 'cu_test_00000001' });
    const confirmHeaders = signedHeaders({ method: 'POST', path: confirmPath, rawBody: body });
    const confirmRes = await request(app).post(confirmPath).set(confirmHeaders).set('Content-Type', 'application/json').send(body);
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe('DELIVERY_PENDING');

    const deliveries = await prisma.collectibleDelivery.findMany({ where: { walletClaim: { orderId: order.id } } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('PENDING');

    await cleanupOrder(order.id, product.id);
  });

  it('common_user_idが不一致の場合409を返す', async () => {
    const token = 'wc-route-mismatch-token';
    const { order, product } = await createEligibleOrderWithClaim('mismatch', token);

    const confirmPath = `/api/integrations/wallet-claims/${token}/confirm`;
    const body = JSON.stringify({ ove_account_id: 'ove-acc-1', common_user_id: 'cu_someone_else' });
    const confirmHeaders = signedHeaders({ method: 'POST', path: confirmPath, rawBody: body });
    const confirmRes = await request(app).post(confirmPath).set(confirmHeaders).set('Content-Type', 'application/json').send(body);
    expect(confirmRes.status).toBe(409);
    expect(confirmRes.body.error.code).toBe('COMMON_USER_MISMATCH');

    await cleanupOrder(order.id, product.id);
  });
});

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)21章「Dispatcher: dry_run」・
// 23章「dry_run成功」: Claim確認API(HTTP・HMAC)→ NftIssue単位Outbox enqueue → dry_run
// ディスパッチまでを一気通貫で確認する結合テスト。dry_runでは実際にfetchを呼ばないことを
// 明示的に検証する(呼ばれたら即座にテストを失敗させる)。
describe('dry_run結合テスト: Claim確認 → NftIssue単位Outbox → dry_runディスパッチ', () => {
  const originalWalletClaimFlag = process.env.ENABLE_WALLET_CLAIM;
  const originalIntegrationFlag = process.env.SENNOKUNI_INTEGRATION_ENABLED;
  const originalDeliveryFlag = process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY;

  beforeAll(async () => {
    await setSetting('wallet_claim_inbound_key_id', KEY_ID);
    await setSetting('wallet_claim_inbound_hmac_secret', SECRET);
    await setSetting('ove_wallet_base_url', 'https://ove-wallet.example.com');
    await setSetting('ove_wallet_events_key_id', 'events-key-dryrun');
    await setSetting('ove_wallet_events_hmac_secret', 'events-secret-dryrun');
  });

  beforeEach(async () => {
    process.env.ENABLE_WALLET_CLAIM = 'true';
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY = 'true';
    await setSennokuniIntegrationStageSetting('dry_run');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.ENABLE_WALLET_CLAIM = originalWalletClaimFlag;
    process.env.SENNOKUNI_INTEGRATION_ENABLED = originalIntegrationFlag;
    process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY = originalDeliveryFlag;
  });

  afterAll(async () => {
    await prisma.setting.deleteMany({
      where: {
        key: {
          in: [
            'wallet_claim_inbound_key_id',
            'wallet_claim_inbound_hmac_secret',
            'ove_wallet_base_url',
            'ove_wallet_events_key_id',
            'ove_wallet_events_hmac_secret',
            'sennokuni_integration_stage',
          ],
        },
      },
    });
    await prisma.$disconnect();
  });

  it('quantity=2の注文がClaim確認→Outbox enqueue→dry_runディスパッチまで実ネットワーク呼び出し無しで完了する', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const token = 'wc-dryrun-integration-token';
    const product = await prisma.product.create({
      data: {
        name: `${PRODUCT_PREFIX}dryrun`,
        slug: `${PRODUCT_PREFIX}dryrun`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 10000,
        status: 'published',
      },
    });
    const rule = await prisma.productIntegrationRule.create({
      data: { productId: product.id, entitlementTargetSystemKey: 'ove-wallet', entitlementType: 'digital_collectible', enabled: true },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: `${ORDER_PREFIX}dryrun`,
        totalAmount: 20000,
        originalAmount: 20000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        customerName: 'dry_run結合テスト太郎',
        customerEmail: 'wc-dryrun-integration-test@example.com',
        termsAgreedAt: new Date(),
        termsVersion: '2026-07-01',
        commonUserId: 'cu_test_00000001',
        commonUserResolutionStatus: 'resolved',
      },
    });
    const orderItem = await prisma.orderItem.create({
      data: { orderId: order.id, productId: product.id, productName: product.name, itemType: 'nft', quantity: 2, unitPrice: 10000, subtotal: 20000 },
    });
    const nftIssues = await Promise.all(
      [1, 2].map((serialNumber) =>
        prisma.nftIssue.create({
          data: { orderId: order.id, orderItemId: orderItem.id, productId: product.id, status: 'wallet_required', serialNumber },
        }),
      ),
    );
    const walletClaim = await prisma.walletClaim.create({
      data: { orderId: order.id, tokenHash: hashClaimToken(token), status: 'PENDING', expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) },
    });
    // Wallet Claim本番前安定化指示書(2026-07-25)Phase4: confirmWalletClaimは決済確定時に作成される
    // WalletClaimItemを基準に判断するため、このテスト用フィクスチャでも同時に作成する。
    await prisma.walletClaimItem.createMany({
      data: nftIssues.map((nftIssue) => ({
        walletClaimId: walletClaim.id,
        nftIssueId: nftIssue.id,
        orderItemId: orderItem.id,
        productId: product.id,
        productIntegrationRuleId: rule.id,
        destinationSystemKey: rule.entitlementTargetSystemKey!,
        entitlementType: rule.entitlementType!,
        name: product.name,
      })),
    });

    const confirmPath = `/api/integrations/wallet-claims/${token}/confirm`;
    const body = JSON.stringify({ ove_account_id: 'ove-acc-dryrun', common_user_id: 'cu_test_00000001' });
    const confirmHeaders = signedHeaders({ method: 'POST', path: confirmPath, rawBody: body });
    const confirmRes = await request(app).post(confirmPath).set(confirmHeaders).set('Content-Type', 'application/json').send(body);
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe('DELIVERY_PENDING');
    expect(confirmRes.body.delivery_count).toBe(2);

    // Wallet Claim本番前安定化指示書(2026-07-25)Phase3: Claim確認トランザクションは同期Dispatcher
    // 呼び出しを行わないため、confirm直後はDelivery・Outboxがpendingのまま残っているはずである。
    expect(fetchMock).not.toHaveBeenCalled();

    const pendingDeliveries = await prisma.collectibleDelivery.findMany({ where: { walletClaim: { orderId: order.id } } });
    expect(pendingDeliveries).toHaveLength(2);
    expect(pendingDeliveries.every((d) => d.status === 'PENDING')).toBe(true);

    const claimBeforeDispatch = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(claimBeforeDispatch.status).toBe('DELIVERY_PENDING');

    // 5分Cron(process-integration-outbox)相当の呼び出しを手動で発火させ、dry_runディスパッチ
    // まで実ネットワーク呼び出し無しで完了することを確認する。
    await dispatchPendingOutboxEvents();
    expect(fetchMock).not.toHaveBeenCalled();

    const deliveries = await prisma.collectibleDelivery.findMany({ where: { walletClaim: { orderId: order.id } } });
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((d) => d.status === 'DELIVERED')).toBe(true);

    const claim = await prisma.walletClaim.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(claim.status).toBe('DELIVERED');

    await cleanupOrder(order.id, product.id);
  });
});
