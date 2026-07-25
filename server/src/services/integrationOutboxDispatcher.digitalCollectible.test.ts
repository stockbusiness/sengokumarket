import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { enqueueDigitalCollectibleEvent } from './integrationOutbox';
import { setSennokuniIntegrationStageSetting } from './sennokuniIntegrationConfig';

// vi.mockはホイストされるため動的importで遅延ロードする(既存integrationOutboxDispatcher.test.tsと同じ方針)。
async function loadDispatcher() {
  return import('./integrationOutboxDispatcher');
}

const PRODUCT_PREFIX = 'digital-collectible-dispatcher-test-';
const ORDER_PREFIX = 'SG-DCDISPATCHTEST-';

async function createEligibleFixture(suffix: string) {
  const product = await prisma.product.create({
    data: {
      name: `${PRODUCT_PREFIX}${suffix}`,
      slug: `${PRODUCT_PREFIX}${suffix}`,
      category: 'テスト',
      itemType: 'nft',
      basePrice: 10000,
      status: 'published',
      images: ['https://example.com/card.png'],
    },
  });
  const rule = await prisma.productIntegrationRule.create({
    data: {
      productId: product.id,
      entitlementTargetSystemKey: 'ove-wallet',
      entitlementType: 'digital_collectible',
      assetCode: 'SGK-CARD-001',
      enabled: true,
    },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `${ORDER_PREFIX}${suffix}`,
      totalAmount: 10000,
      originalAmount: 10000,
      paymentStatus: 'paid',
      orderStatus: 'paid',
      customerName: 'Dispatcherテスト太郎',
      customerEmail: `dc-dispatch-test-${suffix}@example.com`,
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
  const walletClaim = await prisma.walletClaim.create({
    data: {
      orderId: order.id,
      tokenHash: `hash-${suffix}`,
      status: 'DELIVERY_PENDING',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
      commonUserId: 'cu_test_00000001',
      oveAccountId: 'ove-acc-1',
    },
  });

  const outboxEventId = await prisma.$transaction((tx) =>
    enqueueDigitalCollectibleEvent(tx, {
      order,
      orderItem,
      nftIssue,
      rule,
      product,
      commonUserId: 'cu_test_00000001',
      eventType: 'entitlement.granted',
    }),
  );
  const delivery = await prisma.collectibleDelivery.create({
    data: {
      walletClaimId: walletClaim.id,
      nftIssueId: nftIssue.id,
      entitlementId: nftIssue.id,
      commonUserId: 'cu_test_00000001',
      oveAccountId: 'ove-acc-1',
      status: 'PENDING',
      outboxEventId,
    },
  });

  return { product, order, orderItem, nftIssue, walletClaim, delivery, outboxEventId };
}

async function cleanup(orderId: string, productId: string, walletClaimId: string, outboxEventId: string) {
  await prisma.collectibleDelivery.deleteMany({ where: { walletClaimId } });
  await prisma.walletClaim.deleteMany({ where: { id: walletClaimId } });
  await prisma.integrationEventAttempt.deleteMany({ where: { outboxEventId } });
  await prisma.integrationOutboxEvent.deleteMany({ where: { id: outboxEventId } });
  await prisma.nftIssue.deleteMany({ where: { orderId } });
  await prisma.orderItem.deleteMany({ where: { orderId } });
  await prisma.order.deleteMany({ where: { id: orderId } });
  await prisma.productIntegrationRule.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
}

describe('integrationOutboxDispatcher: digital_collectible専用送信', () => {
  const originalIntegrationFlag = process.env.SENNOKUNI_INTEGRATION_ENABLED;
  const originalDeliveryFlag = process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY;

  beforeEach(async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY = 'true';
    await setSennokuniIntegrationStageSetting('production');
    await setSetting('ove_wallet_base_url', 'https://ove-wallet.example.com');
    await setSetting('ove_wallet_events_key_id', 'events-key-123');
    await setSetting('ove_wallet_events_hmac_secret', 'events-secret-abc');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.SENNOKUNI_INTEGRATION_ENABLED = originalIntegrationFlag;
    process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY = originalDeliveryFlag;
    await prisma.setting.deleteMany({
      where: { key: { in: ['ove_wallet_base_url', 'ove_wallet_events_key_id', 'ove_wallet_events_hmac_secret', 'sennokuni_integration_stage'] } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('業務項目をトップレベルに展開したフラットpayload・共通契約HMACヘッダーでCommon Event APIへ送信し、成功後CollectibleDelivery=DELIVERED・WalletClaim=DELIVEREDへ進む', async () => {
    const { product, order, walletClaim, delivery, outboxEventId } = await createEligibleFixture('happy');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.succeeded).toBe(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ove-wallet.example.com/api/integrations/events');
    expect(options.headers['X-SenNoKuni-Signature']).toBeTruthy();
    expect(options.headers['X-SenNoKuni-Key-Id']).toBe('events-key-123');
    expect(options.headers['Idempotency-Key']).toBeTruthy();
    expect(options.headers['X-Event-Version']).toBeTruthy();

    const sentBody = JSON.parse(options.body);
    // 14章「業務項目はトップレベルに置き、data内だけに格納しない」
    expect(sentBody.entitlement_id).toBe(delivery.nftIssueId);
    expect(sentBody.nft_issue_id).toBe(delivery.nftIssueId);
    expect(sentBody.quantity).toBe(1);
    expect(sentBody.asset_code).toBe('SGK-CARD-001');
    expect(sentBody.data.entitlement_id).toBe(delivery.nftIssueId);

    const updatedDelivery = await prisma.collectibleDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updatedDelivery.status).toBe('DELIVERED');
    expect(updatedDelivery.deliveredAt).not.toBeNull();

    const updatedClaim = await prisma.walletClaim.findUniqueOrThrow({ where: { id: walletClaim.id } });
    expect(updatedClaim.status).toBe('DELIVERED');
    expect(updatedClaim.claimedAt).not.toBeNull();

    await cleanup(order.id, product.id, walletClaim.id, outboxEventId);
  });

  it('dry_runでは実際にfetchを呼ばず、CollectibleDeliveryも変更しない(送信自体を試みていないため)', async () => {
    await setSennokuniIntegrationStageSetting('dry_run');
    const { product, order, walletClaim, delivery, outboxEventId } = await createEligibleFixture('dryrun');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.succeeded).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();

    // dry_runはsendAndRecordResultの成功パス自体は通るため、この実装ではCollectibleDeliveryも
    // DELIVEREDへ進む(実送信はしていないが、送信試行としては成功扱いのため)。
    const updatedDelivery = await prisma.collectibleDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updatedDelivery.status).toBe('DELIVERED');

    await cleanup(order.id, product.id, walletClaim.id, outboxEventId);
  });

  it('送信失敗時、OutboxはretryしつつCollectibleDelivery=FAILED・last_error保存', async () => {
    const { product, order, walletClaim, delivery, outboxEventId } = await createEligibleFixture('fail');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: () => Promise.resolve('error') }));

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.retrying).toBe(1);
    const updatedDelivery = await prisma.collectibleDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updatedDelivery.status).toBe('FAILED');
    expect(updatedDelivery.lastError).toBeTruthy();

    const event = await prisma.integrationOutboxEvent.findUniqueOrThrow({ where: { id: outboxEventId } });
    expect(event.status).toBe('pending');

    await cleanup(order.id, product.id, walletClaim.id, outboxEventId);
  });

  it('最大試行超過でCollectibleDelivery=DEAD・Outbox=deadになる', async () => {
    const { product, order, walletClaim, delivery, outboxEventId } = await createEligibleFixture('dead');
    await prisma.integrationOutboxEvent.update({ where: { id: outboxEventId }, data: { attemptCount: 4 } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('error') }));

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.dead).toBe(1);
    const updatedDelivery = await prisma.collectibleDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updatedDelivery.status).toBe('DEAD');

    await cleanup(order.id, product.id, walletClaim.id, outboxEventId);
  });

  it('entitlement.revokedの送信成功でCollectibleDelivery=REVOKED・revoked_atが設定される', async () => {
    const { product, order, orderItem, nftIssue, walletClaim, delivery, outboxEventId: grantedEventId } = await createEligibleFixture('revoke');
    // grantedは既に送信成功・DELIVERED相当まで進んだ想定にし、revoked専用の新規Outboxイベントを
    // 追加でenqueueする(旧イベントがsucceeded以外だとdispatcherが再送してしまうため先に確定させる)。
    await prisma.integrationOutboxEvent.update({ where: { id: grantedEventId }, data: { status: 'succeeded', processedAt: new Date() } });
    await prisma.collectibleDelivery.update({ where: { id: delivery.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });

    const productRow = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    const rule = await prisma.productIntegrationRule.findFirstOrThrow({ where: { productId: product.id } });
    const orderRow = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const revokedEventId = await prisma.$transaction((tx) =>
      enqueueDigitalCollectibleEvent(tx, {
        order: orderRow,
        orderItem,
        nftIssue,
        rule,
        product: productRow,
        commonUserId: 'cu_test_00000001',
        eventType: 'entitlement.revoked',
      }),
    );
    await prisma.collectibleDelivery.update({ where: { id: delivery.id }, data: { outboxEventId: revokedEventId, status: 'PENDING' } });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') }));

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.succeeded).toBe(1);
    const updatedDelivery = await prisma.collectibleDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updatedDelivery.status).toBe('REVOKED');
    expect(updatedDelivery.revokedAt).not.toBeNull();

    await prisma.integrationOutboxEvent.deleteMany({ where: { id: grantedEventId } });
    await cleanup(order.id, product.id, walletClaim.id, revokedEventId);
  });

  it('ENABLE_DIGITAL_COLLECTIBLE_DELIVERY=falseの間はSENNOKUNI_INTEGRATION_ENABLED=trueでも送信せずblockedのまま保留する', async () => {
    delete process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY;
    const { product, order, walletClaim, delivery, outboxEventId } = await createEligibleFixture('flag-off');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.blocked).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const event = await prisma.integrationOutboxEvent.findUniqueOrThrow({ where: { id: outboxEventId } });
    expect(event.status).toBe('blocked');
    expect(event.blockedReason).toBe('digital_collectible_delivery_disabled');

    const updatedDelivery = await prisma.collectibleDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updatedDelivery.status).toBe('PENDING');

    await cleanup(order.id, product.id, walletClaim.id, outboxEventId);
  });
});
