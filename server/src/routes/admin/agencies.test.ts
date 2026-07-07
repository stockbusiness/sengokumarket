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
    await prisma.$disconnect();
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
