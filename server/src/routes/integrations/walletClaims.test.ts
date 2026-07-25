import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { setSetting } from '../../services/settings';
import { buildSennokuniHeaders } from '../../lib/sennokuniHmac';
import { hashClaimToken } from '../../services/walletClaim';

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
  await prisma.productIntegrationRule.create({
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
  await prisma.nftIssue.create({
    data: { orderId: order.id, orderItemId: orderItem.id, productId: product.id, status: 'wallet_required', serialNumber: 1 },
  });
  await prisma.walletClaim.create({
    data: { orderId: order.id, tokenHash: hashClaimToken(token), status: 'PENDING', expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) },
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
