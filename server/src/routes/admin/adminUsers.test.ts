import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const sendAdminAccountSetupEmail = vi.fn(async (..._args: unknown[]) => {});

vi.mock('../../services/mailTemplates', () => ({
  sendAdminAccountSetupEmail: (...args: unknown[]) => sendAdminAccountSetupEmail(...args),
  sendAgencyAccountSetupEmail: vi.fn(async () => {}),
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendPurchaseCompleteEmail: vi.fn(async () => {}),
  sendGuestPasswordSetupEmail: vi.fn(async () => {}),
}));

const app = createApp();

async function createViewerAgent(name: string) {
  const email = `admin-users-test-viewer-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const user = await prisma.user.create({
    data: { name, email, passwordHash: await bcrypt.hash('viewerpassword1', 10), role: 'admin_viewer' },
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'viewerpassword1' });
  return { agent, userId: user.id };
}

describe('管理API: 管理者アカウント管理(仕様書外の拡張)', () => {
  afterAll(async () => {
    await prisma.passwordResetToken.deleteMany({ where: { user: { email: { contains: 'admin-users-test' } } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-users-test' } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('管理者は閲覧専用アカウントを作成でき、パスワード設定メールが送られる', async () => {
    const { agent } = await createAdminAgent(app);
    const email = `admin-users-test-created-${Date.now()}@example.com`;

    const res = await agent
      .post('/api/admin/admin-users')
      .set('Origin', TEST_ORIGIN)
      .send({ name: '閲覧太郎', email, role: 'admin_viewer' });

    expect(res.status).toBe(201);
    expect(res.body.adminUser.role).toBe('admin_viewer');
    expect(sendAdminAccountSetupEmail).toHaveBeenCalledWith(email, '閲覧太郎', expect.any(String), '閲覧専用管理者');

    const list = await agent.get('/api/admin/admin-users');
    expect(list.body.adminUsers.some((u: { email: string }) => u.email === email)).toBe(true);
  });

  it('閲覧専用アカウントは一覧取得(GET)はできるが、作成(POST)は403になる', async () => {
    const { agent: viewerAgent } = await createViewerAgent('閲覧一覧太郎');

    const listRes = await viewerAgent.get('/api/admin/admin-users');
    expect(listRes.status).toBe(200);

    const createRes = await viewerAgent
      .post('/api/admin/admin-users')
      .set('Origin', TEST_ORIGIN)
      .send({ name: 'x', email: `admin-users-test-blocked-${Date.now()}@example.com`, role: 'admin' });
    expect(createRes.status).toBe(403);
    expect(createRes.body.error.code).toBe('READONLY_ADMIN');
  });

  it('閲覧専用アカウントは他の管理APIの書き込み操作も403になるが、閲覧はできる', async () => {
    const { agent: viewerAgent } = await createViewerAgent('閲覧他機能太郎');

    const dashboardRes = await viewerAgent.get('/api/admin/dashboard');
    expect(dashboardRes.status).toBe(200);

    const noticeRes = await viewerAgent
      .post('/api/admin/notices')
      .set('Origin', TEST_ORIGIN)
      .send({ title: 'x', body: 'y' });
    expect(noticeRes.status).toBe(403);
    expect(noticeRes.body.error.code).toBe('READONLY_ADMIN');
  });

  it('自分自身の権限は変更できない', async () => {
    const { agent, userId } = await createAdminAgent(app);
    const res = await agent.put(`/api/admin/admin-users/${userId}/role`).set('Origin', TEST_ORIGIN).send({ role: 'admin_viewer' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CANNOT_CHANGE_OWN_ROLE');
  });

  it('管理者は他の管理者の権限を変更できる(admin_viewer→adminへの昇格)', async () => {
    const { agent } = await createAdminAgent(app);
    const { userId: viewerUserId } = await createViewerAgent('昇格対象太郎');

    const res = await agent.put(`/api/admin/admin-users/${viewerUserId}/role`).set('Origin', TEST_ORIGIN).send({ role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.adminUser.role).toBe('admin');
  });
});
