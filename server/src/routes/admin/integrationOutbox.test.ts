import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';
import { enqueueOutboxEvent } from '../../services/integrationOutbox';
import { setSetting } from '../../services/settings';
import { setSennokuniIntegrationStageSetting } from '../../services/sennokuniIntegrationConfig';

const app = createApp();

async function createViewerAgent() {
  const email = `integration-outbox-viewer-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const user = await prisma.user.create({
    data: { name: '閲覧専用管理者', email, passwordHash: await bcrypt.hash('viewerpassword1', 10), role: 'admin_viewer' },
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'viewerpassword1' });
  return { agent, userId: user.id };
}

describe('管理API: 連携Outbox一覧(仕様書外の拡張・千ノ国全体統合)', () => {
  const correlationId = `integration-outbox-route-test-${Date.now()}`;

  afterAll(async () => {
    await prisma.integrationOutboxEvent.deleteMany({ where: { correlationId } });
    await prisma.user.deleteMany({ where: { email: { contains: 'integration-outbox-viewer-test' } } });
    await prisma.$disconnect();
  });

  it('管理者は一覧を取得でき、statusで絞り込める', async () => {
    const { agent } = await createAdminAgent(app);

    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, {
        eventType: 'entitlement.granted',
        destinationSystemKey: 'sengoku-passport',
        payload: { foo: 'bar' },
        correlationId,
      });
    });

    const res = await agent.get('/api/admin/integration-outbox');
    expect(res.status).toBe(200);
    expect(res.body.outboxEvents.some((e: { correlationId: string }) => e.correlationId === correlationId)).toBe(true);
    // 仕様書外の拡張(保守性改善Phase8): ページネーション情報を返す。
    expect(res.body.page).toBe(1);
    expect(typeof res.body.pageSize).toBe('number');
    expect(res.body.total).toBeGreaterThanOrEqual(1);

    const filtered = await agent.get('/api/admin/integration-outbox?status=pending');
    expect(filtered.status).toBe(200);
    expect(filtered.body.outboxEvents.every((e: { status: string }) => e.status === 'pending')).toBe(true);

    const succeededOnly = await agent.get('/api/admin/integration-outbox?status=succeeded');
    expect(succeededOnly.status).toBe(200);
    expect(succeededOnly.body.outboxEvents.some((e: { correlationId: string }) => e.correlationId === correlationId)).toBe(
      false,
    );
  });

  // 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)19章「Digital Collectible Outbox」:
  // 専用一覧を新設する代わりに、この既存一覧へentitlement_id・destinationSystemKeyでの
  // 絞り込みを追加した(重複した一覧実装を避けるための再利用)。
  it('entitlementId・destinationSystemKeyで絞り込める', async () => {
    const { agent: adminAgent } = await createAdminAgent(app);
    const dcCorrelationId = `${correlationId}-dc`;
    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, {
        eventType: 'entitlement.granted',
        destinationSystemKey: 'ove-wallet',
        payload: { entitlement_id: 'nft-issue-entitlement-test-1', entitlement_type: 'digital_collectible' },
        correlationId: dcCorrelationId,
      });
    });

    const res = await adminAgent.get('/api/admin/integration-outbox?entitlementId=nft-issue-entitlement-test-1');
    expect(res.status).toBe(200);
    expect(res.body.outboxEvents).toHaveLength(1);
    expect(res.body.outboxEvents[0].correlationId).toBe(dcCorrelationId);

    const byDestination = await adminAgent.get('/api/admin/integration-outbox?destinationSystemKey=ove-wallet');
    expect(byDestination.status).toBe(200);
    expect(byDestination.body.outboxEvents.every((e: { destinationSystemKey: string }) => e.destinationSystemKey === 'ove-wallet')).toBe(true);

    await prisma.integrationOutboxEvent.deleteMany({ where: { correlationId: dcCorrelationId } });
  });

  it('残課題指示書Stage6: status=blockedで絞り込み、blocked理由(blockedReason)を確認できる', async () => {
    const { agent } = await createAdminAgent(app);
    const blockedCorrelationId = `${correlationId}-blocked`;

    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, {
        eventType: 'entitlement.granted',
        destinationSystemKey: 'sengoku-passport',
        payload: { foo: 'bar' },
        correlationId: blockedCorrelationId,
      });
    });
    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId: blockedCorrelationId } });
    await prisma.integrationOutboxEvent.update({
      where: { id: row.id },
      data: { status: 'blocked', blockedReason: 'common_user_unresolved' },
    });

    const res = await agent.get('/api/admin/integration-outbox?status=blocked');
    expect(res.status).toBe(200);
    const found = res.body.outboxEvents.find((e: { correlationId: string }) => e.correlationId === blockedCorrelationId);
    expect(found).toBeTruthy();
    expect(found.blockedReason).toBe('common_user_unresolved');

    await prisma.integrationOutboxEvent.deleteMany({ where: { correlationId: blockedCorrelationId } });
  });

  it('不正なstatusは400になる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/integration-outbox?status=not_a_status');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('閲覧専用管理者(admin_viewer)もGETは閲覧できる', async () => {
    const { agent } = await createViewerAgent();
    const res = await agent.get('/api/admin/integration-outbox');
    expect(res.status).toBe(200);
  });

  it('未認証は401になる', async () => {
    const res = await request(app).get('/api/admin/integration-outbox');
    expect(res.status).toBe(401);
  });
});

// 本番安定化指示書Stage11(14.1「Integration Attempts」・14.4「試行履歴を確認可能」)。
describe('管理API: 連携Outbox試行履歴(本番安定化指示書Stage11)', () => {
  const correlationId = `integration-outbox-attempts-test-${Date.now()}`;

  afterAll(async () => {
    await prisma.integrationOutboxEvent.deleteMany({ where: { correlationId } });
    await prisma.$disconnect();
  });

  it('試行履歴が無いイベントは空配列を返す', async () => {
    const { agent } = await createAdminAgent(app);
    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, { eventType: 'entitlement.granted', destinationSystemKey: 'sengoku-passport', payload: {}, correlationId });
    });
    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });

    const res = await agent.get(`/api/admin/integration-outbox/${row.id}/attempts`);
    expect(res.status).toBe(200);
    expect(res.body.attempts).toEqual([]);
  });

  it('試行履歴があれば attempt_number 昇順で返す', async () => {
    const { agent } = await createAdminAgent(app);
    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });
    await prisma.integrationEventAttempt.createMany({
      data: [
        { outboxEventId: row.id, attemptNumber: 2, startedAt: new Date(), result: 'failed', error: '2回目失敗' },
        { outboxEventId: row.id, attemptNumber: 1, startedAt: new Date(), result: 'failed', error: '1回目失敗' },
      ],
    });

    const res = await agent.get(`/api/admin/integration-outbox/${row.id}/attempts`);
    expect(res.status).toBe(200);
    expect(res.body.attempts).toHaveLength(2);
    expect(res.body.attempts[0].attemptNumber).toBe(1);
    expect(res.body.attempts[1].attemptNumber).toBe(2);

    await prisma.integrationEventAttempt.deleteMany({ where: { outboxEventId: row.id } });
  });

  it('存在しないイベントIDは404', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/integration-outbox/00000000-0000-0000-0000-000000000000/attempts');
    expect(res.status).toBe(404);
  });

  it('未認証は401になる', async () => {
    const res = await request(app).get('/api/admin/integration-outbox/00000000-0000-0000-0000-000000000000/attempts');
    expect(res.status).toBe(401);
  });
});

// 残課題指示書Stage7・9.2「手動再送」。
describe('管理API: 連携Outbox手動再送(残課題指示書Stage7)', () => {
  const originalFlag = process.env.SENNOKUNI_INTEGRATION_ENABLED;

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.SENNOKUNI_INTEGRATION_ENABLED = originalFlag;
    await prisma.setting.deleteMany({
      where: {
        key: {
          in: [
            'sennokuni_hmac_key_id',
            'sennokuni_hmac_secret',
            'sennokuni_agency_hub_base_url',
            'integration_endpoint_sengoku_passport',
            'integration_endpoint_path_sengoku_passport',
            'sennokuni_integration_stage',
          ],
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('Feature Flag無効時は手動再送しても404(実送信を行わない)', async () => {
    delete process.env.SENNOKUNI_INTEGRATION_ENABLED;
    const { agent } = await createAdminAgent(app);
    const correlationId = `integration-outbox-retry-disabled-test-${Date.now()}`;
    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, { eventType: 'entitlement.granted', destinationSystemKey: 'sengoku-passport', payload: {}, correlationId });
    });
    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });
    await prisma.integrationOutboxEvent.update({ where: { id: row.id }, data: { status: 'dead' } });

    const res = await agent.post(`/api/admin/integration-outbox/${row.id}/retry`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(404);

    await prisma.integrationOutboxEvent.deleteMany({ where: { correlationId } });
  });

  it('Feature Flag有効時、dead状態のイベントを再送でき成功すればsucceededになる', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');
    await setSetting('integration_endpoint_sengoku_passport', 'https://passport.example.com');
    await setSetting('integration_endpoint_path_sengoku_passport', '/shopping/webhook');
    // 本番安定化指示書Stage8(11.4): 既定はdry_run(実送信しない)になったため、実際にfetchが
    // 呼ばれることを検証するこのテストではproductionへ明示的に固定する。
    await setSennokuniIntegrationStageSetting('production');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const { agent } = await createAdminAgent(app);
    const correlationId = `integration-outbox-retry-test-${Date.now()}`;
    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, { eventType: 'entitlement.granted', destinationSystemKey: 'sengoku-passport', payload: {}, correlationId });
    });
    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });
    await prisma.integrationOutboxEvent.update({ where: { id: row.id }, data: { status: 'dead' } });

    const res = await agent.post(`/api/admin/integration-outbox/${row.id}/retry`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('succeeded');

    const attempts = await prisma.integrationEventAttempt.findMany({ where: { outboxEventId: row.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].result).toBe('succeeded');

    await prisma.integrationEventAttempt.deleteMany({ where: { outboxEventId: row.id } });
    await prisma.integrationOutboxEvent.deleteMany({ where: { correlationId } });
  });

  it('存在しないIDは404', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .post('/api/admin/integration-outbox/00000000-0000-0000-0000-000000000000/retry')
      .set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(404);
  });

  it('閲覧専用管理者は403(READONLY_ADMIN)', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    const { agent } = await createViewerAgent();
    const correlationId = `integration-outbox-retry-viewer-test-${Date.now()}`;
    await prisma.$transaction(async (tx) => {
      await enqueueOutboxEvent(tx, { eventType: 'entitlement.granted', destinationSystemKey: 'sengoku-passport', payload: {}, correlationId });
    });
    const row = await prisma.integrationOutboxEvent.findFirstOrThrow({ where: { correlationId } });

    const res = await agent.post(`/api/admin/integration-outbox/${row.id}/retry`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('READONLY_ADMIN');

    await prisma.integrationOutboxEvent.deleteMany({ where: { correlationId } });
  });
});
