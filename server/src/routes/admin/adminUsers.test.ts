import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const sendNotificationOrThrowMock = vi.fn(async (..._args: unknown[]) => {});
vi.mock('../../modules/notifications/application/sendNotification.usecase', () => ({
  sendNotification: async (..._args: unknown[]) => {},
  sendNotificationOrThrow: (...args: unknown[]) => sendNotificationOrThrowMock(...args),
}));

const app = createApp();

async function createViewerAgent(name: string) {
  const email = `admin-users-test-viewer-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const user = await prisma.user.create({
    data: { name, email, passwordHash: await bcrypt.hash('viewerpassword1', 10), role: 'admin_viewer' },
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'viewerpassword1' });
  return { agent, userId: user.id, email };
}

describe('管理API: 管理者アカウント管理(仕様書外の拡張)', () => {
  afterEach(() => {
    sendNotificationOrThrowMock.mockClear();
  });

  afterAll(async () => {
    await prisma.notificationOutboxEvent.deleteMany({ where: { recipient: { contains: 'admin-users-test' } } });
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

    // Wallet Claim本番前安定化指示書Phase11: 管理者操作起点の送信のため即時ディスパッチまで
    // リクエスト応答内で完了している(admin_account_setupはOutboxを経由しつつも同期的に送信される)。
    const event = await prisma.notificationOutboxEvent.findFirstOrThrow({ where: { recipient: email, eventType: 'admin_account_setup' } });
    expect(event.status).toBe('succeeded');
    expect(sendNotificationOrThrowMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: email, text: expect.stringContaining('閲覧専用管理者') }),
    );

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

  it('管理者はスタッフアカウントを作成でき、パスワード設定メールが送られる', async () => {
    const { agent } = await createAdminAgent(app);
    const email = `admin-users-test-staff-${Date.now()}@example.com`;

    const res = await agent
      .post('/api/admin/admin-users')
      .set('Origin', TEST_ORIGIN)
      .send({ name: 'スタッフ太郎', email, role: 'staff' });

    expect(res.status).toBe(201);
    expect(res.body.adminUser.role).toBe('staff');

    const event = await prisma.notificationOutboxEvent.findFirstOrThrow({ where: { recipient: email, eventType: 'admin_account_setup' } });
    expect(event.status).toBe('succeeded');
    expect(sendNotificationOrThrowMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: email, text: expect.stringContaining('スタッフ') }),
    );

    const list = await agent.get('/api/admin/admin-users');
    expect(list.body.adminUsers.some((u: { email: string }) => u.email === email)).toBe(true);
  });

  it('パスワード設定メールを再送できる', async () => {
    const { agent } = await createAdminAgent(app);
    const { userId: viewerUserId, email: viewerEmail } = await createViewerAgent('再送対象太郎');

    sendNotificationOrThrowMock.mockClear();
    const res = await agent.post(`/api/admin/admin-users/${viewerUserId}/resend-setup-email`).set('Origin', TEST_ORIGIN).send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const events = await prisma.notificationOutboxEvent.findMany({ where: { recipient: viewerEmail, eventType: 'admin_account_setup' } });
    expect(events.some((e) => e.status === 'succeeded')).toBe(true);
    expect(sendNotificationOrThrowMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: viewerEmail, text: expect.stringContaining('再送対象太郎') }),
    );
  });

  it('存在しないアカウントへの再送は404になる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .post('/api/admin/admin-users/00000000-0000-0000-0000-000000000000/resend-setup-email')
      .set('Origin', TEST_ORIGIN)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ADMIN_USER_NOT_FOUND');
  });

  // 残課題指示書Stage11: JWT即時失効。この機能自体の効果(旧Cookieが実際に失効すること)は
  // auth.test.tsの「残課題指示書Stage11」describeで確認する。ここではエンドポイント単体の挙動のみ。
  it('強制ログアウトAPIは対象アカウントのsessionVersionを進める', async () => {
    const { agent } = await createAdminAgent(app);
    const { userId: viewerUserId } = await createViewerAgent('強制ログアウト対象太郎');

    const before = await prisma.user.findUniqueOrThrow({ where: { id: viewerUserId } });
    const res = await agent.post(`/api/admin/admin-users/${viewerUserId}/force-logout`).set('Origin', TEST_ORIGIN).send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: viewerUserId } });
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
  });

  it('存在しないアカウントへの強制ログアウトは404になる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .post('/api/admin/admin-users/00000000-0000-0000-0000-000000000000/force-logout')
      .set('Origin', TEST_ORIGIN)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ADMIN_USER_NOT_FOUND');
  });

  it('自分自身のアカウントは削除できない', async () => {
    const { agent, userId } = await createAdminAgent(app);
    const res = await agent.delete(`/api/admin/admin-users/${userId}`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CANNOT_DELETE_SELF');
  });

  it('管理者は他の管理者アカウントを削除でき、一覧から消える', async () => {
    const { agent } = await createAdminAgent(app);
    const { userId: viewerUserId } = await createViewerAgent('削除対象太郎');

    const res = await agent.delete(`/api/admin/admin-users/${viewerUserId}`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const found = await prisma.user.findUnique({ where: { id: viewerUserId } });
    expect(found).toBeNull();
  });

  it('閲覧専用アカウントは削除操作も403になる', async () => {
    const { agent: viewerAgent } = await createViewerAgent('削除権限確認太郎');
    const { userId: targetId } = await createViewerAgent('削除される側太郎');

    const res = await viewerAgent.delete(`/api/admin/admin-users/${targetId}`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('READONLY_ADMIN');
  });
});
