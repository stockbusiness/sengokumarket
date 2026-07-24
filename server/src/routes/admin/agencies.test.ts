import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const syncAgencyHierarchyFromExternalSystem = vi.fn(async () => ({ agenciesSynced: 3, applicationsApproved: 1 }));

vi.mock('../../services/agencyHierarchySync', () => ({
  syncAgencyHierarchyFromExternalSystem: () => syncAgencyHierarchyFromExternalSystem(),
}));

const app = createApp();

describe('管理API: 外部代理店システムとの階層同期(仕様書外の拡張)', () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-agencies-sync-test' } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
  });

  it('管理者は同期を実行でき、結果件数が返る', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.post('/api/admin/agencies/sync-external').set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agenciesSynced: 3, applicationsApproved: 1 });
  });

  it('閲覧専用管理者は403(READONLY_ADMIN)', async () => {
    const email = `admin-agencies-sync-test-viewer-${Date.now()}@example.com`;
    await prisma.user.create({
      data: { name: '閲覧専用', email, passwordHash: await bcrypt.hash('viewerpassword1', 10), role: 'admin_viewer' },
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'viewerpassword1' });

    const res = await agent.post('/api/admin/agencies/sync-external').set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('READONLY_ADMIN');
  });

  it('一般ユーザーは403', async () => {
    const email = `admin-agencies-sync-test-user-${Date.now()}@example.com`;
    const agent = request.agent(app);
    await agent.post('/api/auth/register').set('Origin', TEST_ORIGIN).send({ name: '一般', email, password: 'password123' });

    const res = await agent.post('/api/admin/agencies/sync-external').set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(403);
  });
});

// 残課題指示書Stage3・5.6: ログインユーザーが既に存在する代理店への設定メール手動再送。
describe('管理API: 代理店設定メール再送(残課題指示書Stage3)', () => {
  afterAll(async () => {
    await prisma.notificationOutboxEvent.deleteMany({ where: { recipient: { contains: 'admin-agencies-resend-test' } } });
    await prisma.passwordResetToken.deleteMany({ where: { user: { email: { contains: 'admin-agencies-resend-test' } } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-agencies-resend-test' } } });
    await prisma.agency.deleteMany({ where: { code: { contains: 'admin-agencies-resend-test' } } });
    await prisma.$disconnect();
  });

  async function createAgencyWithLogin() {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const agency = await prisma.agency.create({
      data: {
        name: '再送テスト代理店',
        code: `admin-agencies-resend-test-${suffix}`,
        externalId: `admin-agencies-resend-test-ext-${suffix}`,
        status: 'active',
        defaultCommissionRate: 0,
      },
    });
    const email = `admin-agencies-resend-test-${suffix}@example.com`;
    const user = await prisma.user.create({
      data: { name: '代理店担当者', email, passwordHash: await bcrypt.hash('setupplaceholder1', 10), role: 'agency', agencyId: agency.id },
    });
    return { agency, user };
  }

  it('ログインユーザーが存在する代理店には再送でき、notification_outbox_eventsが作成される', async () => {
    const { agent } = await createAdminAgent(app);
    const { agency, user } = await createAgencyWithLogin();

    const res = await agent.post(`/api/admin/agencies/${agency.id}/resend-setup-email`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const events = await prisma.notificationOutboxEvent.findMany({ where: { recipient: user.email } });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].eventType).toBe('agency_account_setup');
  });

  it('ログインユーザーが存在しない代理店は404', async () => {
    const { agent } = await createAdminAgent(app);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const agency = await prisma.agency.create({
      data: {
        name: 'ログイン未設定代理店',
        code: `admin-agencies-resend-test-nologin-${suffix}`,
        externalId: `admin-agencies-resend-test-nologin-ext-${suffix}`,
        status: 'active',
        defaultCommissionRate: 0,
      },
    });

    const res = await agent.post(`/api/admin/agencies/${agency.id}/resend-setup-email`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('AGENCY_LOGIN_NOT_FOUND');
  });

  it('閲覧専用管理者は403(READONLY_ADMIN)', async () => {
    const email = `admin-agencies-resend-test-viewer-${Date.now()}@example.com`;
    await prisma.user.create({
      data: { name: '閲覧専用', email, passwordHash: await bcrypt.hash('viewerpassword1', 10), role: 'admin_viewer' },
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'viewerpassword1' });

    const { agency } = await createAgencyWithLogin();
    const res = await agent.post(`/api/admin/agencies/${agency.id}/resend-setup-email`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('READONLY_ADMIN');
  });
});
