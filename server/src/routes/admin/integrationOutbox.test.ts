import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';
import { enqueueOutboxEvent } from '../../services/integrationOutbox';

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
