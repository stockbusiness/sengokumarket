import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';
import { enqueueNotification } from '../../modules/notifications/infrastructure/notificationOutbox.repository';

vi.mock('../../modules/notifications/infrastructure/resend.adapter', () => ({
  sendViaResendOrThrow: vi.fn(async () => undefined),
  sendViaResend: vi.fn(async () => undefined),
}));

const app = createApp();

async function createViewerAgent() {
  const email = `notification-outbox-viewer-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await prisma.user.create({
    data: { name: '閲覧専用管理者', email, passwordHash: await bcrypt.hash('viewerpassword1', 10), role: 'admin_viewer' },
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'viewerpassword1' });
  return { agent };
}

describe('管理API: 代理店通知Outbox一覧(残課題指示書Stage3)', () => {
  const recipient = `notification-outbox-route-test-${Date.now()}@example.com`;

  afterAll(async () => {
    await prisma.notificationOutboxEvent.deleteMany({ where: { recipient } });
    await prisma.user.deleteMany({ where: { email: { contains: 'notification-outbox-viewer-test' } } });
    await prisma.$disconnect();
  });

  it('管理者は一覧を取得でき、statusで絞り込める', async () => {
    const { agent } = await createAdminAgent(app);

    await enqueueNotification(prisma, {
      eventType: 'agency_access_granted',
      recipient,
      payload: { name: '通知テスト' },
    });

    const res = await agent.get('/api/admin/notification-outbox');
    expect(res.status).toBe(200);
    expect(res.body.notificationOutboxEvents.some((e: { recipient: string }) => e.recipient === recipient)).toBe(true);
    expect(res.body.page).toBe(1);
    expect(typeof res.body.pageSize).toBe('number');
    expect(res.body.total).toBeGreaterThanOrEqual(1);

    const filtered = await agent.get('/api/admin/notification-outbox?status=pending');
    expect(filtered.status).toBe(200);
    expect(filtered.body.notificationOutboxEvents.every((e: { status: string }) => e.status === 'pending')).toBe(true);

    const succeededOnly = await agent.get('/api/admin/notification-outbox?status=succeeded');
    expect(succeededOnly.status).toBe(200);
    expect(
      succeededOnly.body.notificationOutboxEvents.some((e: { recipient: string }) => e.recipient === recipient),
    ).toBe(false);
  });

  it('不正なstatusは400になる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/notification-outbox?status=not_a_status');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('閲覧専用管理者(admin_viewer)もGETは閲覧できる', async () => {
    const { agent } = await createViewerAgent();
    const res = await agent.get('/api/admin/notification-outbox');
    expect(res.status).toBe(200);
  });

  it('未認証は401になる', async () => {
    const res = await request(app).get('/api/admin/notification-outbox');
    expect(res.status).toBe(401);
  });
});

describe('管理API: 代理店通知Outbox手動再送(残課題指示書Stage3)', () => {
  const recipient = `notification-outbox-retry-test-${Date.now()}@example.com`;

  afterAll(async () => {
    await prisma.notificationOutboxEvent.deleteMany({ where: { recipient } });
    await prisma.$disconnect();
  });

  it('failed状態のイベントを再送できる', async () => {
    const { agent } = await createAdminAgent(app);
    const event = await enqueueNotification(prisma, {
      eventType: 'agency_access_granted',
      recipient,
      payload: { name: '再送テスト' },
    });
    await prisma.notificationOutboxEvent.update({ where: { id: event.id }, data: { status: 'failed' } });

    const res = await agent.post(`/api/admin/notification-outbox/${event.id}/retry`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const updated = await prisma.notificationOutboxEvent.findUnique({ where: { id: event.id } });
    expect(updated?.status).toBe('succeeded');
  });

  it('存在しないIDは404', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .post('/api/admin/notification-outbox/00000000-0000-0000-0000-000000000000/retry')
      .set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('閲覧専用管理者は403(READONLY_ADMIN)', async () => {
    const { agent } = await createViewerAgent();
    const event = await enqueueNotification(prisma, {
      eventType: 'agency_access_granted',
      recipient,
      payload: { name: '再送テスト' },
    });
    const res = await agent.post(`/api/admin/notification-outbox/${event.id}/retry`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('READONLY_ADMIN');
  });
});
