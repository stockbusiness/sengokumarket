import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

describe('管理API: 監査ログ(仕様書外の拡張)', () => {
  afterAll(async () => {
    await prisma.notice.deleteMany({ where: { title: { contains: 'audit-log-test' } } });
    await prisma.adminAuditLog.deleteMany({ where: { path: { contains: '/api/admin/notices' } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('管理者による状態変更操作(POST)が監査ログに記録される', async () => {
    const { agent, email } = await createAdminAgent(app);

    const res = await agent
      .post('/api/admin/notices')
      .set('Origin', TEST_ORIGIN)
      .send({ title: 'audit-log-test 1', body: '本文' });

    expect(res.status).toBe(201);

    const logs = await prisma.adminAuditLog.findMany({
      where: { path: '/api/admin/notices', method: 'POST', actorEmail: email },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].statusCode).toBe(201);
    expect(logs[0].actorRole).toBe('admin');
    expect((logs[0].requestBody as Record<string, unknown>).title).toBe('audit-log-test 1');
  });

  it('GETリクエストは監査ログに記録されない', async () => {
    const { agent } = await createAdminAgent(app);

    await agent.get('/api/admin/notices').set('Origin', TEST_ORIGIN);

    const logs = await prisma.adminAuditLog.findMany({ where: { path: '/api/admin/notices', method: 'GET' } });
    expect(logs).toHaveLength(0);
  });

  it('決済連携キー等の秘密情報はリクエストボディがそのまま記録されない(マスクされる)', async () => {
    const { agent, email } = await createAdminAgent(app);

    await agent
      .put('/api/admin/settings')
      .set('Origin', TEST_ORIGIN)
      .send({ stripe_secret_key: 'sk_live_secretvalue', external_agency_system_api_key: 'external-secret-value' });

    const logs = await prisma.adminAuditLog.findMany({
      where: { path: '/api/admin/settings', method: 'PUT', actorEmail: email },
    });
    expect(logs).toHaveLength(1);
    expect((logs[0].requestBody as Record<string, unknown>).stripe_secret_key).toBe('[REDACTED]');
    expect((logs[0].requestBody as Record<string, unknown>).external_agency_system_api_key).toBe('[REDACTED]');
  });

  it('GET /api/admin/audit-logs で新しい順に一覧取得できる', async () => {
    const { agent } = await createAdminAgent(app);

    await agent.post('/api/admin/notices').set('Origin', TEST_ORIGIN).send({ title: 'audit-log-test 2', body: '本文' });

    const res = await agent.get('/api/admin/audit-logs').set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.logs.length).toBeGreaterThan(0);
    expect(new Date(res.body.logs[0].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(res.body.logs[1]?.createdAt ?? 0).getTime());
  });
});
