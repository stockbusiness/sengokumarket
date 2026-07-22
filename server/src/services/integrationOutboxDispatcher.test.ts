import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { enqueueOutboxEvent } from './integrationOutbox';

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

    expect(result).toEqual({ claimed: 0, succeeded: 0, retrying: 0, dead: 0, skipped: 0 });
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
    expect((row.payload as Record<string, unknown>).ove_transaction_id).toBe('tx_test_001');
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
});
