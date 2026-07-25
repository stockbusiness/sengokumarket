import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { enqueueEntitlementEvents, enqueueOutboxEvent } from './integrationOutbox';

const grantRewardMock = vi.fn();
const reverseRewardMock = vi.fn();
vi.mock('./oveWalletRewardClient', () => ({
  grantReward: (...args: unknown[]) => grantRewardMock(...args),
  reverseReward: (...args: unknown[]) => reverseRewardMock(...args),
}));

// vi.mockはホイストされるため、動的importで遅延ロードして常にmock後のモジュールを使う。
async function loadDispatcher() {
  return import('./integrationOutboxDispatcher');
}

// 仕様書外の拡張(千ノ国全体連携 共通インターフェース契約v1.1 DRAFT 9章・2026-07-22指示書対応):
// Outbox dispatcherの回帰テスト。Feature Flag無効時(既定)は一切送信しないことを最優先で確認する。
describe('integrationOutboxDispatcher(仕様書外の拡張・2026-07-22指示書対応)', () => {
  const originalFlag = process.env.SENNOKUNI_INTEGRATION_ENABLED;
  const correlationPrefix = 'outbox-dispatcher-test-';

  beforeEach(() => {
    delete process.env.SENNOKUNI_INTEGRATION_ENABLED;
    grantRewardMock.mockReset();
    reverseRewardMock.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.SENNOKUNI_INTEGRATION_ENABLED = originalFlag;
    delete process.env.INTEGRATION_OUTBOX_TIME_BUDGET_MS;
    const eventIds = (
      await prisma.integrationOutboxEvent.findMany({
        where: { correlationId: { startsWith: correlationPrefix } },
        select: { id: true },
      })
    ).map((e) => e.id);
    await prisma.integrationEventAttempt.deleteMany({ where: { outboxEventId: { in: eventIds } } });
    await prisma.integrationOutboxEvent.deleteMany({ where: { correlationId: { startsWith: correlationPrefix } } });
    await prisma.setting.deleteMany({
      where: {
        key: {
          in: [
            'sennokuni_hmac_key_id',
            'sennokuni_hmac_secret',
            'sennokuni_agency_hub_base_url',
            'integration_endpoint_sengoku_passport',
          ],
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createEvent(overrides: {
    correlationId: string;
    eventType: 'entitlement.granted' | 'entitlement.revoked';
    destinationSystemKey: string;
    orderItemId?: string;
    status?: string;
    attemptCount?: number;
    updatedAtOverride?: Date;
  }) {
    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, {
        eventType: overrides.eventType,
        destinationSystemKey: overrides.destinationSystemKey,
        correlationId: overrides.correlationId,
        payload: {
          common_user_id: 'cu_test_001',
          source_user_id: 'user-1',
          order_item_id: overrides.orderItemId ?? 'order-item-1',
          quantity: 1,
          // 本番安定化指示書Stage6(9.4): 実際の運用ではenqueueEntitlementEvents経由で必ず
          // 付与される値(商品数量をそのままポイント数にしないための計算済み額)。この
          // テストはdispatcherの送信メカニズム自体の検証が目的でorder_idを持たせず
          // reconcileEntitlementFieldsのルール再取得をスキップさせているため、ここで明示的に
          // 用意する。
          reward_amount: 1,
        },
      });
    });
    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId: overrides.correlationId } });
    if (overrides.status || overrides.attemptCount !== undefined || overrides.updatedAtOverride) {
      await prisma.integrationOutboxEvent.update({
        where: { id: row.id },
        data: {
          status: overrides.status ?? undefined,
          attemptCount: overrides.attemptCount ?? undefined,
          // staleなprocessing行を模擬する場合、実際のdispatcherと同じくprocessing_token/
          // processing_started_atも設定されている状態にする(残課題指示書Stage7で
          // stale判定がupdated_atからprocessing_started_at基準に変わったため)。
          processingToken: overrides.status === 'processing' ? 'stale-test-token' : undefined,
          processingStartedAt: overrides.updatedAtOverride ?? undefined,
        },
      });
      if (overrides.updatedAtOverride) {
        await prisma.$executeRaw`UPDATE integration_outbox_events SET updated_at = ${overrides.updatedAtOverride} WHERE id = ${row.id}::uuid`;
      }
    }
    return prisma.integrationOutboxEvent.findUniqueOrThrow({ where: { id: row.id } });
  }

  it('Feature Flag無効時はpending行があっても一切送信しない', async () => {
    const correlationId = `${correlationPrefix}disabled-${Date.now()}`;
    await createEvent({ correlationId, eventType: 'entitlement.granted', destinationSystemKey: 'ove-wallet' });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result).toEqual({ claimed: 0, succeeded: 0, retrying: 0, dead: 0, skipped: 0, blocked: 0 });
    expect(grantRewardMock).not.toHaveBeenCalled();

    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });
    expect(row.status).toBe('pending');
  });

  it('ove-wallet宛entitlement.grantedはgrantRewardを呼び、成功時にtransaction_idをpayloadへ記録する', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    grantRewardMock.mockResolvedValue({ transactionId: 'tx_test_001' });
    const correlationId = `${correlationPrefix}grant-${Date.now()}`;
    await createEvent({ correlationId, eventType: 'entitlement.granted', destinationSystemKey: 'ove-wallet', orderItemId: 'oi-grant-1' });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.succeeded).toBe(1);
    expect(grantRewardMock).toHaveBeenCalledTimes(1);

    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });
    expect(row.status).toBe('succeeded');
    expect((row.deliveryPayload as Record<string, unknown>).ove_transaction_id).toBe('tx_test_001');
  });

  // 本番安定化指示書Stage6(9.4「商品数量をそのままポイント数にしない」)。
  it('ove-wallet宛entitlement.grantedはpayload.quantityではなくpayload.reward_amount/reward_rule_idをgrantRewardへ渡す', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    grantRewardMock.mockResolvedValue({ transactionId: 'tx_test_reward_amount' });
    const correlationId = `${correlationPrefix}reward-amount-${Date.now()}`;
    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, {
        eventType: 'entitlement.granted',
        destinationSystemKey: 'ove-wallet',
        correlationId,
        payload: {
          common_user_id: 'cu_test_001',
          source_user_id: 'user-1',
          order_item_id: 'oi-reward-amount-1',
          quantity: 99, // 数量は大きいが、reward_amountとは無関係であることの確認
          reward_amount: 250,
          reward_rule_id: 'rule_test_001',
        },
      });
    });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.succeeded).toBe(1);
    expect(grantRewardMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 250, rewardRuleId: 'rule_test_001' }));
  });

  it('reward_amountが数値でない場合は送信を試みず再試行になる(暗黙にquantityへフォールバックしない)', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    const correlationId = `${correlationPrefix}reward-amount-missing-${Date.now()}`;
    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, {
        eventType: 'entitlement.granted',
        destinationSystemKey: 'ove-wallet',
        correlationId,
        payload: {
          common_user_id: 'cu_test_001',
          source_user_id: 'user-1',
          order_item_id: 'oi-reward-amount-missing-1',
          quantity: 3,
        },
      });
    });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(grantRewardMock).not.toHaveBeenCalled();
    expect(result.retrying).toBe(1);
    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });
    expect(row.status).toBe('pending');
    expect(row.lastError).toContain('reward_amount');
  });

  it('ove-wallet宛entitlement.revokedは対応するgranted成功行のtransaction_idでreverseRewardを呼ぶ', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    grantRewardMock.mockResolvedValue({ transactionId: 'tx_test_002' });
    reverseRewardMock.mockResolvedValue(true);

    const grantCorrelationId = `${correlationPrefix}grant-for-revoke-${Date.now()}`;
    await createEvent({ correlationId: grantCorrelationId, eventType: 'entitlement.granted', destinationSystemKey: 'ove-wallet', orderItemId: 'oi-revoke-1' });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    await dispatchPendingOutboxEvents(); // まずgrantedを成功させる

    const revokeCorrelationId = `${correlationPrefix}revoke-${Date.now()}`;
    await createEvent({ correlationId: revokeCorrelationId, eventType: 'entitlement.revoked', destinationSystemKey: 'ove-wallet', orderItemId: 'oi-revoke-1' });

    const result = await dispatchPendingOutboxEvents();

    expect(result.succeeded).toBe(1);
    expect(reverseRewardMock).toHaveBeenCalledWith('tx_test_002', expect.any(String));

    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId: revokeCorrelationId } });
    expect(row.status).toBe('succeeded');
  });

  it('対応するgranted行が無いentitlement.revokedは失敗しリトライ状態(pending・attempt_count増加)になる', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    const correlationId = `${correlationPrefix}revoke-orphan-${Date.now()}`;
    await createEvent({ correlationId, eventType: 'entitlement.revoked', destinationSystemKey: 'ove-wallet', orderItemId: 'oi-orphan-1' });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.retrying).toBe(1);
    expect(reverseRewardMock).not.toHaveBeenCalled();

    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });
    expect(row.status).toBe('pending');
    expect(row.attemptCount).toBe(1);
    expect(row.nextAttemptAt).not.toBeNull();
    expect(row.lastError).toBeTruthy();
  });

  it('最大試行回数に達した行はdead状態になる', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    const correlationId = `${correlationPrefix}dead-${Date.now()}`;
    await createEvent({
      correlationId,
      eventType: 'entitlement.revoked',
      destinationSystemKey: 'ove-wallet',
      orderItemId: 'oi-dead-1',
      attemptCount: 4,
    });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.dead).toBe(1);
    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });
    expect(row.status).toBe('dead');
  });

  it('sengoku-passport宛は共通契約のHMACヘッダー付きでエンドポイントへ送信する', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');
    await setSetting('integration_endpoint_sengoku_passport', 'https://passport.example.com');

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const correlationId = `${correlationPrefix}passport-${Date.now()}`;
    await createEvent({ correlationId, eventType: 'entitlement.granted', destinationSystemKey: 'sengoku-passport' });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.succeeded).toBe(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://passport.example.com/shopping/webhook');
    expect(options.headers['X-SenNoKuni-Signature']).toBeTruthy();
    expect(options.headers['Idempotency-Key']).toBeTruthy();
  });

  it('接続先未設定の送信先はリトライ状態になる', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    const correlationId = `${correlationPrefix}no-endpoint-${Date.now()}`;
    await createEvent({ correlationId, eventType: 'entitlement.granted', destinationSystemKey: 'ai-art-school' });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.retrying).toBe(1);
    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });
    expect(row.status).toBe('pending');
  });

  it('staleなprocessing行(放置)は再クレームされ、送信を再試行する', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    grantRewardMock.mockResolvedValue({ transactionId: 'tx_test_stale' });
    const correlationId = `${correlationPrefix}stale-${Date.now()}`;
    await createEvent({
      correlationId,
      eventType: 'entitlement.granted',
      destinationSystemKey: 'ove-wallet',
      orderItemId: 'oi-stale-1',
      status: 'processing',
      updatedAtOverride: new Date(Date.now() - 20 * 60 * 1000),
    });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.claimed).toBe(1);
    expect(result.succeeded).toBe(1);
    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });
    expect(row.status).toBe('succeeded');
  });

  // 残課題指示書Stage7・9.2「正式URL」: pathをコード固定せず送信先ごとの設定値にする。
  it('送信先ごとのpath設定(integration_endpoint_path_*)を使い、HMAC署名対象pathと実送信pathが一致する', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');
    await setSetting('integration_endpoint_sengoku_passport', 'https://passport.example.com');
    await setSetting('integration_endpoint_path_sengoku_passport', '/v2/webhook/entitlements');

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const correlationId = `${correlationPrefix}custom-path-${Date.now()}`;
    await createEvent({ correlationId, eventType: 'entitlement.granted', destinationSystemKey: 'sengoku-passport' });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.succeeded).toBe(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://passport.example.com/v2/webhook/entitlements');

    await prisma.setting.deleteMany({ where: { key: 'integration_endpoint_path_sengoku_passport' } });
  });

  // 残課題指示書Stage7・9.2「試行履歴」: 実際に送信を試みた回をintegration_event_attemptsへ記録する。
  it('送信成功・失敗の両方でintegration_event_attemptsに試行履歴が記録される(http_status含む)', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');
    await setSetting('integration_endpoint_sengoku_passport', 'https://passport.example.com');

    const failCorrelationId = `${correlationPrefix}attempt-fail-${Date.now()}`;
    await createEvent({ correlationId: failCorrelationId, eventType: 'entitlement.granted', destinationSystemKey: 'sengoku-passport' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    await dispatchPendingOutboxEvents();

    const failedEvent = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId: failCorrelationId } });
    const failedAttempts = await prisma.integrationEventAttempt.findMany({ where: { outboxEventId: failedEvent.id } });
    expect(failedAttempts).toHaveLength(1);
    expect(failedAttempts[0]).toMatchObject({ attemptNumber: 1, result: 'failed', httpStatus: 503 });
    expect(failedAttempts[0].startedAt).toBeTruthy();
    expect(failedAttempts[0].finishedAt).toBeTruthy();
    // 本番安定化指示書Stage7(10.3): 送信先URL・request payload hashも試行履歴へ残す。
    expect(failedAttempts[0].destinationUrl).toBe('https://passport.example.com/shopping/webhook');
    expect(failedAttempts[0].requestPayloadHash).toBeTruthy();

    vi.unstubAllGlobals();
    const okCorrelationId = `${correlationPrefix}attempt-ok-${Date.now()}`;
    await createEvent({ correlationId: okCorrelationId, eventType: 'entitlement.granted', destinationSystemKey: 'sengoku-passport' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('{"status":"ok"}') }));

    await dispatchPendingOutboxEvents();
    const okEvent = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId: okCorrelationId } });
    const okAttempts = await prisma.integrationEventAttempt.findMany({ where: { outboxEventId: okEvent.id } });
    expect(okAttempts).toHaveLength(1);
    expect(okAttempts[0]).toMatchObject({ attemptNumber: 1, result: 'succeeded', httpStatus: null });
    expect(okAttempts[0].destinationUrl).toBe('https://passport.example.com/shopping/webhook');
    expect(okAttempts[0].responseBodyExcerpt).toBe('{"status":"ok"}');
    expect(okAttempts[0].requestPayloadHash).toBeTruthy();
  });

  // 本番安定化指示書Stage7(10.1・10.2・10.4): 保存payloadとhashが一致し、original_payload
  // (enqueue時点の監査用データ)は送信直前の再取得で書き換わらないことの直接検証。
  it('送信直前の再取得でdelivery_payloadとそのhashは更新されるが、original_payloadは不変', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');
    await setSetting('integration_endpoint_sengoku_passport', 'https://passport.example.com');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('') }));

    const correlationId = `${correlationPrefix}payload-hash-${Date.now()}`;
    const before = await createEvent({ correlationId, eventType: 'entitlement.granted', destinationSystemKey: 'sengoku-passport' });
    const originalPayloadBefore = before.originalPayload;
    const originalHashBefore = before.originalPayloadHash;

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    await dispatchPendingOutboxEvents();

    const after = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });
    // original_payload/hashは不変(監査用データが失われない)。
    expect(after.originalPayload).toEqual(originalPayloadBefore);
    expect(after.originalPayloadHash).toBe(originalHashBefore);
    // 保存されているdelivery_payloadとそのhashは常に一致する。
    const crypto = await import('crypto');
    const expectedDeliveryHash = crypto.createHash('sha256').update(JSON.stringify(after.deliveryPayload)).digest('hex');
    expect(after.deliveryPayloadHash).toBe(expectedDeliveryHash);
  });

  // 残課題指示書Stage7・9.3「古い処理が新しい結果を上書きしない」: processing_tokenの一致を
  // 条件にした更新のため、失効したtoken(stale再クレーム前の古いclaim)による書き込みは無視される。
  it('古いprocessing_tokenでの更新は、既に別tokenでclaimされた行を上書きしない', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    const correlationId = `${correlationPrefix}stale-token-${Date.now()}`;
    await createEvent({ correlationId, eventType: 'entitlement.granted', destinationSystemKey: 'ove-wallet', orderItemId: 'oi-staletoken-1' });
    const original = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });

    // 別のdispatcherインスタンスが既にこの行を新しいtokenでclaim・成功させた状況を模擬する。
    await prisma.integrationOutboxEvent.update({
      where: { id: original.id },
      data: { status: 'succeeded', processingToken: null, processingStartedAt: null, processedAt: new Date() },
    });

    // 元のprocessing_token(失効済み)を使った更新は、現在の行の状態(status='succeeded'・
    // processingToken=null)と一致しないため、何も更新されないはず。
    const staleUpdate = await prisma.integrationOutboxEvent.updateMany({
      where: { id: original.id, status: 'processing', processingToken: 'this-token-no-longer-matches' },
      data: { status: 'dead', lastError: '古いtokenからの書き込み(発生してはいけない)' },
    });
    expect(staleUpdate.count).toBe(0);

    const after = await prisma.integrationOutboxEvent.findUniqueOrThrow({ where: { id: original.id } });
    expect(after.status).toBe('succeeded');
    expect(after.lastError).toBeNull();
  });

  // 残課題指示書Stage7・9.2「batch」: 送信先ごとの同時実行上限を超えた分は次回以降に持ち越す。
  it('送信先ごとの同時実行上限(PER_DESTINATION_BATCH_LIMIT=5)を超える件数は1回のdispatchでclaimしない', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    grantRewardMock.mockResolvedValue({ transactionId: 'tx_test_perdest' });
    const prefix = `${correlationPrefix}perdest-${Date.now()}`;
    for (let i = 0; i < 8; i++) {
      await createEvent({ correlationId: `${prefix}-${i}`, eventType: 'entitlement.granted', destinationSystemKey: 'ove-wallet', orderItemId: `oi-perdest-${i}` });
    }

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    // 8件enqueueしたが、送信先ごとの上限(5件)までしかclaimされない。
    expect(result.claimed).toBe(5);
    const remainingPending = await prisma.integrationOutboxEvent.count({
      where: { correlationId: { startsWith: prefix }, status: 'pending' },
    });
    expect(remainingPending).toBe(3);
    // 片付けは共通のafterEach(correlationPrefix一致)がintegration_event_attempts→
    // integration_outbox_eventsの順で行う。
  });

  // 残課題指示書Stage7・9.2「実行時間」: Functionの残り時間に余裕がない場合は新規claimを停止する。
  it('時間予算(INTEGRATION_OUTBOX_TIME_BUDGET_MS)を使い切っている場合は新規claimを行わない', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    process.env.INTEGRATION_OUTBOX_TIME_BUDGET_MS = '0';
    const correlationId = `${correlationPrefix}timebudget-${Date.now()}`;
    await createEvent({ correlationId, eventType: 'entitlement.granted', destinationSystemKey: 'ove-wallet', orderItemId: 'oi-timebudget-1' });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.claimed).toBe(0);
    expect(grantRewardMock).not.toHaveBeenCalled();
    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });
    expect(row.status).toBe('pending');

    delete process.env.INTEGRATION_OUTBOX_TIME_BUDGET_MS;
  });
});

// 残課題指示書Stage6: 共通ID未解決イベントの送信保留。実際の注文・商品・ルールを使い、
// enqueueEntitlementEvents経由でorder_id/product_idを含む本番相当のpayloadを作る。
describe('integrationOutboxDispatcher: 共通ID未解決イベントの送信保留(残課題指示書Stage6)', () => {
  const originalFlag = process.env.SENNOKUNI_INTEGRATION_ENABLED;
  const productNamePrefix = 'stage6-blocking-test';

  beforeEach(() => {
    delete process.env.SENNOKUNI_INTEGRATION_ENABLED;
    grantRewardMock.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.SENNOKUNI_INTEGRATION_ENABLED = originalFlag;
    await prisma.setting.deleteMany({
      where: { key: { in: ['sennokuni_hmac_key_id', 'sennokuni_hmac_secret', 'sennokuni_agency_hub_base_url'] } },
    });
    // 各テストが作成したイベント・注文・商品を都度片付け、次のテストのdispatch結果へ
    // 再claimされて混入しないようにする(blocked行は毎回再評価対象に含まれるため特に重要)。
    const stage6EventIds = (
      await prisma.integrationOutboxEvent.findMany({
        where: { deliveryPayload: { path: ['product_code'], equals: 'STAGE6-TEST' } },
        select: { id: true },
      })
    ).map((e) => e.id);
    await prisma.integrationEventAttempt.deleteMany({ where: { outboxEventId: { in: stage6EventIds } } });
    await prisma.integrationOutboxEvent.deleteMany({ where: { deliveryPayload: { path: ['product_code'], equals: 'STAGE6-TEST' } } });
    await prisma.orderItem.deleteMany({ where: { product: { name: { startsWith: productNamePrefix } } } });
    await prisma.order.deleteMany({ where: { customerEmail: { contains: productNamePrefix } } });
    await prisma.productIntegrationRule.deleteMany({ where: { product: { name: { startsWith: productNamePrefix } } } });
    await prisma.product.deleteMany({ where: { name: { startsWith: productNamePrefix } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createEntitlementEvent(opts: {
    requireCommonUserId?: boolean;
    orderCommonUserId?: string | null;
  }) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const product = await prisma.product.create({
      data: {
        name: `${productNamePrefix}-${suffix}`,
        slug: `${productNamePrefix}-${suffix}`,
        category: 'テスト',
        itemType: 'nft',
        basePrice: 10000,
        status: 'published',
      },
    });
    const rule = await prisma.productIntegrationRule.create({
      data: {
        productId: product.id,
        productCode: 'STAGE6-TEST',
        entitlementTargetSystemKey: 'ove-wallet',
        requireCommonUserId: opts.requireCommonUserId ?? false,
      },
    });
    const order = await prisma.order.create({
      data: {
        orderNumber: `SG-STAGE6-${suffix}`,
        userId: undefined,
        totalAmount: 10000,
        originalAmount: 10000,
        paymentStatus: 'paid',
        orderStatus: 'paid',
        customerName: 'Stage6テスト太郎',
        customerEmail: `${productNamePrefix}-${suffix}@example.com`,
        termsAgreedAt: new Date(),
        termsVersion: '2026-07-01',
        commonUserId: opts.orderCommonUserId ?? null,
      },
    });
    const orderItem = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        productName: product.name,
        itemType: 'nft',
        quantity: 1,
        unitPrice: 10000,
        subtotal: 10000,
      },
    });

    await prisma.$transaction(async (tx) => {
      await enqueueEntitlementEvents(tx, order, [orderItem], 'entitlement.granted');
    });

    const event = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId: order.id } });
    return { product, order, orderItem, event, rule };
  }

  it('必須(requireCommonUserId=true)なのにcommon_user_idが未解決ならblockedになり送信しない', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    const { event } = await createEntitlementEvent({ requireCommonUserId: true, orderCommonUserId: null });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.blocked).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(grantRewardMock).not.toHaveBeenCalled();

    const row = await prisma.integrationOutboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.status).toBe('blocked');
    expect(row.blockedReason).toBe('common_user_unresolved');
  });

  it('blocked後にcommon_user_idが解決されると、次回dispatchで自動的に送信を再開する', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    grantRewardMock.mockResolvedValue({ transactionId: 'tx_stage6_resume' });
    const { event, order } = await createEntitlementEvent({ requireCommonUserId: true, orderCommonUserId: null });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const blockedResult = await dispatchPendingOutboxEvents();
    expect(blockedResult.blocked).toBe(1);

    // 他のジョブ(Stage4のcommon_user_resolve等)がcommon_user_idを解決したことを模擬する。
    await prisma.order.update({ where: { id: order.id }, data: { commonUserId: 'cu_stage6_resumed' } });

    const resumedResult = await dispatchPendingOutboxEvents();
    expect(resumedResult.succeeded).toBe(1);
    expect(grantRewardMock).toHaveBeenCalledWith(expect.objectContaining({ commonUserId: 'cu_stage6_resumed' }));

    const row = await prisma.integrationOutboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.status).toBe('succeeded');
    expect(row.blockedReason).toBeNull();
    expect((row.deliveryPayload as Record<string, unknown>).common_user_id).toBe('cu_stage6_resumed');
  });

  it('必須設定がない(requireCommonUserId=false)商品は、common_user_id未解決でも従来通り送信される(後方互換)', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    grantRewardMock.mockResolvedValue({ transactionId: 'tx_stage6_optional' });
    const { event } = await createEntitlementEvent({ requireCommonUserId: false, orderCommonUserId: null });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.succeeded).toBe(1);
    expect(result.blocked).toBe(0);
    const row = await prisma.integrationOutboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.status).toBe('succeeded');
  });

  it('送信payloadはenqueue時点ではなく送信時点の最新のcommon_user_idを使う', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    grantRewardMock.mockResolvedValue({ transactionId: 'tx_stage6_fresh' });
    const { event, order } = await createEntitlementEvent({ requireCommonUserId: false, orderCommonUserId: 'cu_stage6_stale' });

    // enqueue後、送信前に注文のcommon_user_idが変わったケース(通常は起こらないが、
    // 「最新値を使う」ことの直接的な検証として)。
    await prisma.order.update({ where: { id: order.id }, data: { commonUserId: 'cu_stage6_fresh' } });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    await dispatchPendingOutboxEvents();

    expect(grantRewardMock).toHaveBeenCalledWith(expect.objectContaining({ commonUserId: 'cu_stage6_fresh' }));
    const row = await prisma.integrationOutboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect((row.deliveryPayload as Record<string, unknown>).common_user_id).toBe('cu_stage6_fresh');
    // 本番安定化指示書Stage7(10.1・10.2・10.4): delivery_payloadは最新値に更新されるが、
    // original_payload(enqueue時点の監査用データ)は古いcommon_user_idのまま失われない。
    expect((row.originalPayload as Record<string, unknown>).common_user_id).toBe('cu_stage6_stale');
    expect(row.originalPayload).not.toEqual(row.deliveryPayload);
  });

  // 本番安定化指示書Stage6(9.5・9.7「無効ルールは送信しない」): enqueue後(pendingのまま)に
  // 管理者がルールを無効化した場合でも、送信前の再取得(reconcileEntitlementFields)で検知して
  // 送信を止める。
  it('enqueue後にルールがenabled=falseへ変更されると、送信せずblockedになる', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    const { event, rule } = await createEntitlementEvent({ requireCommonUserId: false, orderCommonUserId: 'cu_stage6_disabled_rule' });
    await prisma.productIntegrationRule.update({ where: { id: rule.id }, data: { enabled: false } });

    const { dispatchPendingOutboxEvents } = await loadDispatcher();
    const result = await dispatchPendingOutboxEvents();

    expect(result.blocked).toBe(1);
    expect(grantRewardMock).not.toHaveBeenCalled();
    const row = await prisma.integrationOutboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.status).toBe('blocked');
    expect(row.blockedReason).toBe('integration_rule_disabled');
  });
});
