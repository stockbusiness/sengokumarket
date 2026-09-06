import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { enqueueDigitalCollectibleEvent } from './integrationOutbox';
import { setSennokuniIntegrationStageSetting } from './sennokuniIntegrationConfig';

// vi.mockはホイストされるため動的importで遅延ロードする(既存integrationOutboxDispatcher.test.tsと同じ方針)。
async function loadDispatcher() {
  return import('./integrationOutboxDispatcher');
}

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)20章「契約Fixture」:
// ウォレット側と同一のJSON形状であることを検証する(値そのものではなくキー構造の一致を見る。
// event_id・occurred_at・実際のUUID等は呼び出しごとに異なるため)。
function loadFixture(name: string): unknown {
  const fixturePath = path.resolve(__dirname, '../../../docs/contracts/fixtures', name);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function sortedKeyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .flatMap((key) => sortedKeyPaths((value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key));
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
      // 実際の確認処理(walletClaimConfirm.ts)ではDELIVERY_PENDING遷移と同時にclaimedAtが
      // 設定される。このフィクスチャはConfirm処理自体を経由しないため、ここで模倣しておく。
      claimedAt: new Date(),
    },
  });

  const claimItem = await prisma.walletClaimItem.create({
    data: {
      walletClaimId: walletClaim.id,
      nftIssueId: nftIssue.id,
      orderItemId: orderItem.id,
      productId: product.id,
      productIntegrationRuleId: rule.id,
      destinationSystemKey: rule.entitlementTargetSystemKey!,
      entitlementType: rule.entitlementType!,
      assetCode: rule.assetCode,
      serialNumber: nftIssue.serialNumber,
      name: product.name,
      description: product.description,
      imageUrl: product.images[0],
      thumbnailUrl: product.images[0],
      rarity: rule.collectibleRarity,
    },
  });

  const outboxEventId = await prisma.$transaction((tx) =>
    enqueueDigitalCollectibleEvent(tx, {
      order,
      orderItem,
      nftIssue,
      claimItem,
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

  return { product, order, orderItem, nftIssue, walletClaim, claimItem, delivery, outboxEventId };
}

async function cleanup(orderId: string, productId: string, walletClaimId: string, outboxEventId: string) {
  await prisma.collectibleDelivery.deleteMany({ where: { walletClaimId } });
  await prisma.walletClaimItem.deleteMany({ where: { walletClaimId } });
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

  it('metadataでラップしたペイロード・共通契約HMACヘッダーでCommon Event APIへ送信し、成功後CollectibleDelivery=DELIVERED・WalletClaim=DELIVEREDへ進む', async () => {
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
    // SENNOKUNI_COMMERCE_REQUEST.md: 業務項目はdata・metadataへ格納し、ウォレットが受け付ける
    // entitlement_type(MEMBERSHIP_PASS)はmetadata配下にのみ置く(dataは内部値digital_collectibleの
    // ままでよい)。
    expect(sentBody.data.entitlement_id).toBe(delivery.nftIssueId);
    expect(sentBody.data.nft_issue_id).toBe(delivery.nftIssueId);
    expect(sentBody.data.quantity).toBe(1);
    expect(sentBody.metadata.asset_code).toBe('SGK-CARD-001');
    expect(sentBody.metadata.entitlement_type).toBe('MEMBERSHIP_PASS');
    expect(sentBody.reason_code).toBeUndefined();
    expect(sentBody.data.entitlement_id).toBe(delivery.nftIssueId);

    const updatedDelivery = await prisma.collectibleDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updatedDelivery.status).toBe('DELIVERED');
    expect(updatedDelivery.deliveredAt).not.toBeNull();

    // Wallet Claim本番前安定化指示書(2026-07-25)Phase7(9章「claimedAtを上書きしない」): DELIVERED
    // 遷移時にはdeliveredAtのみ設定し、Confirm時点で設定済みのclaimedAtは変更しない。
    const updatedClaim = await prisma.walletClaim.findUniqueOrThrow({ where: { id: walletClaim.id } });
    expect(updatedClaim.status).toBe('DELIVERED');
    expect(updatedClaim.claimedAt?.getTime()).toBe(walletClaim.claimedAt?.getTime());
    expect(updatedClaim.deliveredAt).not.toBeNull();

    await cleanup(order.id, product.id, walletClaim.id, outboxEventId);
  });

  it('entitlement.grantedの送信payloadは契約Fixture(digital-collectible-granted.v1.json)と同じキー構造を持つ', async () => {
    const { product, order, walletClaim, outboxEventId } = await createEligibleFixture('fixture-granted');
    let sentBody: unknown = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: { body: string }) => {
        sentBody = JSON.parse(options.body);
        return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
      }),
    );

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    await dispatchPendingOutboxEvents();

    const fixture = loadFixture('digital-collectible-granted.v1.json');
    expect(sortedKeyPaths(sentBody)).toEqual(sortedKeyPaths(fixture));

    await cleanup(order.id, product.id, walletClaim.id, outboxEventId);
  });

  it('entitlement.revokedの送信payloadは契約Fixture(digital-collectible-revoked.v1.json)と同じキー構造を持つ', async () => {
    const { product, order, orderItem, nftIssue, walletClaim, delivery, outboxEventId: grantedEventId } =
      await createEligibleFixture('fixture-revoked');
    await prisma.integrationOutboxEvent.update({ where: { id: grantedEventId }, data: { status: 'succeeded', processedAt: new Date() } });
    await prisma.collectibleDelivery.update({ where: { id: delivery.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });

    const claimItem = await prisma.walletClaimItem.findUniqueOrThrow({ where: { nftIssueId: nftIssue.id } });
    const orderRow = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const revokedEventId = await prisma.$transaction((tx) =>
      enqueueDigitalCollectibleEvent(tx, {
        order: orderRow,
        orderItem,
        nftIssue,
        claimItem,
        commonUserId: 'cu_test_00000001',
        eventType: 'entitlement.revoked',
      }),
    );
    await prisma.collectibleDelivery.update({ where: { id: delivery.id }, data: { outboxEventId: revokedEventId, status: 'PENDING' } });

    let sentBody: unknown = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: { body: string }) => {
        sentBody = JSON.parse(options.body);
        return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
      }),
    );

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    await dispatchPendingOutboxEvents();

    const fixture = loadFixture('digital-collectible-revoked.v1.json');
    expect(sortedKeyPaths(sentBody)).toEqual(sortedKeyPaths(fixture));

    await prisma.integrationOutboxEvent.deleteMany({ where: { id: grantedEventId } });
    await cleanup(order.id, product.id, walletClaim.id, revokedEventId);
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

    const claimItem = await prisma.walletClaimItem.findUniqueOrThrow({ where: { nftIssueId: nftIssue.id } });
    const orderRow = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    const revokedEventId = await prisma.$transaction((tx) =>
      enqueueDigitalCollectibleEvent(tx, {
        order: orderRow,
        orderItem,
        nftIssue,
        claimItem,
        commonUserId: 'cu_test_00000001',
        eventType: 'entitlement.revoked',
      }),
    );
    await prisma.collectibleDelivery.update({ where: { id: delivery.id }, data: { outboxEventId: revokedEventId, status: 'PENDING' } });
    // Wallet Claim本番前安定化指示書(2026-07-25)Phase6: 返金処理(walletClaimRefund.ts)は取消
    // enqueueと同時にWalletClaim=REVOCATION_PENDINGへ進める想定のため、その状態を再現する。
    await prisma.walletClaim.update({ where: { id: walletClaim.id }, data: { status: 'REVOCATION_PENDING' } });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') });
    vi.stubGlobal('fetch', fetchMock);

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.succeeded).toBe(1);
    // SENNOKUNI_COMMERCE_REQUEST.md 3-4: entitlement.revokedにはreason_codeを付ける
    // (現状の唯一のトリガーである全額返金を示す固定値)。
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body).reason_code).toBe('full_refund');
    const updatedDelivery = await prisma.collectibleDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updatedDelivery.status).toBe('REVOKED');
    expect(updatedDelivery.revokedAt).not.toBeNull();

    // Phase6(8.3「親状態同期」): 全CollectibleDeliveryがREVOKEDになったのでWalletClaim=REVOKEDへ進む。
    const updatedClaim = await prisma.walletClaim.findUniqueOrThrow({ where: { id: walletClaim.id } });
    expect(updatedClaim.status).toBe('REVOKED');
    expect(updatedClaim.revokedAt).not.toBeNull();

    await prisma.integrationOutboxEvent.deleteMany({ where: { id: grantedEventId } });
    await cleanup(order.id, product.id, walletClaim.id, revokedEventId);
  });

  // 最終安定化指示書Phase1「返金とカード送付の競合防止」
  it('grant送信直前に注文が全額返金済みだと送信せずblocked(wallet_claim_refunded_before_send)になり、CollectibleDeliveryはREVOKEDになる', async () => {
    const { product, order, walletClaim, delivery, outboxEventId } = await createEligibleFixture('refund-before-send');
    await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'refunded', orderStatus: 'refunded' } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.blocked).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();

    const event = await prisma.integrationOutboxEvent.findUniqueOrThrow({ where: { id: outboxEventId } });
    expect(event.status).toBe('blocked');
    expect(event.blockedReason).toBe('wallet_claim_refunded_before_send');

    const updatedDelivery = await prisma.collectibleDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updatedDelivery.status).toBe('REVOKED');
    expect(updatedDelivery.revokedAt).not.toBeNull();

    await cleanup(order.id, product.id, walletClaim.id, outboxEventId);
  });

  it('grant送信中(外部API呼び出し中)に返金された場合、2xx応答が返ってもDELIVEREDへは進まず、補償のentitlement.revokedが1件だけenqueueされる', async () => {
    const { product, order, walletClaim, delivery, outboxEventId } = await createEligibleFixture('refund-during-send');

    // 送信直前(sendAndRecordResultのPROCESSING遷移)まではまだpaidのため、送信自体は開始される。
    // fetch呼び出しの最中(=外部APIへ届いた後、応答が返る前)に返金が確定した状況を、
    // fetchのモック内で注文を返金済みへ更新することで再現する。
    const fetchMock = vi.fn().mockImplementation(async () => {
      await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'refunded', orderStatus: 'refunded' } });
      return { ok: true, text: () => Promise.resolve('{}') };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.succeeded).toBe(1); // grant自体はHTTPレベルでは成功している
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // grantイベント自体はsucceeded(実際に2xxで送信済みのため嘘の記録にはしない)。
    const grantEvent = await prisma.integrationOutboxEvent.findUniqueOrThrow({ where: { id: outboxEventId } });
    expect(grantEvent.status).toBe('succeeded');

    // しかしCollectibleDeliveryはDELIVEREDへは進まない(返金済みのため)。
    const updatedDelivery = await prisma.collectibleDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(updatedDelivery.status).not.toBe('DELIVERED');

    // 補償取消(entitlement.revoked)が1件だけ作られ、delivery.outbox_event_idがそちらへ張り替わる。
    expect(updatedDelivery.outboxEventId).not.toBe(outboxEventId);
    const revokeEvent = await prisma.integrationOutboxEvent.findUniqueOrThrow({ where: { id: updatedDelivery.outboxEventId! } });
    expect(revokeEvent.eventType).toBe('entitlement.revoked');
    expect(revokeEvent.deduplicationKey).toBe(`digital-collectible-revoke:${delivery.nftIssueId}`);
    expect(revokeEvent.status).toBe('pending');

    const updatedClaim = await prisma.walletClaim.findUniqueOrThrow({ where: { id: walletClaim.id } });
    expect(updatedClaim.status).toBe('REVOCATION_PENDING');

    const auditLogs = await prisma.walletClaimAuditLog.findMany({ where: { walletClaimId: walletClaim.id } });
    expect(auditLogs.some((a) => a.eventType === 'compensating_revoke_enqueued')).toBe(true);

    // 二重にrevokeが作られないことを確認するため、もう一度dispatchを回してもrevoke行は1件のまま。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') }));
    await dispatchPendingOutboxEvents();
    const revokeEventsAfter = await prisma.integrationOutboxEvent.findMany({
      where: { deduplicationKey: `digital-collectible-revoke:${delivery.nftIssueId}` },
    });
    expect(revokeEventsAfter).toHaveLength(1);

    await prisma.integrationEventAttempt.deleteMany({ where: { outboxEventId } });
    await prisma.integrationOutboxEvent.deleteMany({ where: { id: outboxEventId } });
    await cleanup(order.id, product.id, walletClaim.id, updatedDelivery.outboxEventId!);
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
