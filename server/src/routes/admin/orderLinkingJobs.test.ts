import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';
import { enqueueCommonUserResolveJob } from '../../services/orderLinkingJobs';
import { setSetting } from '../../services/settings';

const app = createApp();

async function createViewerAgent() {
  const email = `order-linking-jobs-viewer-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const user = await prisma.user.create({
    data: { name: '閲覧専用管理者', email, passwordHash: await bcrypt.hash('viewerpassword1', 10), role: 'admin_viewer' },
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'viewerpassword1' });
  return { agent, userId: user.id };
}

async function createLinkingUser(emailSuffix: string) {
  return prisma.user.create({
    data: {
      name: 'ジョブ管理APIテストユーザー',
      email: `order-linking-jobs-route-test-${emailSuffix}-${Date.now()}@example.com`,
      passwordHash: await bcrypt.hash('password123', 10),
    },
  });
}

// 本番安定化指示書Stage5(8.6): order_linking_jobsの一覧・手動再送・skip・backlog件数確認。
describe('管理API: order-linking-jobs一覧(本番安定化指示書Stage5)', () => {
  const createdUserIds: string[] = [];

  afterAll(async () => {
    await prisma.orderLinkingJob.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'order-linking-jobs-viewer-test' } } });
    await prisma.$disconnect();
  });

  it('管理者は一覧を取得でき、statusで絞り込める', async () => {
    const { agent } = await createAdminAgent(app);
    const user = await createLinkingUser('list');
    createdUserIds.push(user.id);
    const job = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));

    const res = await agent.get('/api/admin/order-linking-jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs.some((j: { id: string }) => j.id === job.id)).toBe(true);
    expect(res.body.page).toBe(1);
    expect(typeof res.body.pageSize).toBe('number');
    expect(res.body.total).toBeGreaterThanOrEqual(1);

    const filtered = await agent.get('/api/admin/order-linking-jobs?status=pending');
    expect(filtered.status).toBe(200);
    expect(filtered.body.jobs.every((j: { status: string }) => j.status === 'pending')).toBe(true);

    const succeededOnly = await agent.get('/api/admin/order-linking-jobs?status=succeeded');
    expect(succeededOnly.status).toBe(200);
    expect(succeededOnly.body.jobs.some((j: { id: string }) => j.id === job.id)).toBe(false);
  });

  it('status=blockedで絞り込み、blockedReasonを確認できる', async () => {
    const { agent } = await createAdminAgent(app);
    const user = await createLinkingUser('blocked');
    createdUserIds.push(user.id);
    const job = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));
    await prisma.orderLinkingJob.update({
      where: { id: job.id },
      data: { status: 'blocked', blockedReason: 'common_user_unresolved' },
    });

    const res = await agent.get('/api/admin/order-linking-jobs?status=blocked');
    expect(res.status).toBe(200);
    const found = res.body.jobs.find((j: { id: string }) => j.id === job.id);
    expect(found).toBeTruthy();
    expect(found.blockedReason).toBe('common_user_unresolved');
  });

  it('不正なstatusは400になる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/order-linking-jobs?status=not_a_status');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('閲覧専用管理者(admin_viewer)もGETは閲覧できる', async () => {
    const { agent } = await createViewerAgent();
    const res = await agent.get('/api/admin/order-linking-jobs');
    expect(res.status).toBe(200);
  });

  it('未認証は401になる', async () => {
    const res = await request(app).get('/api/admin/order-linking-jobs');
    expect(res.status).toBe(401);
  });

  it('backlogはpending・blockedの件数を返す', async () => {
    const { agent } = await createAdminAgent(app);
    const user = await createLinkingUser('backlog');
    createdUserIds.push(user.id);
    await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));

    const res = await agent.get('/api/admin/order-linking-jobs/backlog');
    expect(res.status).toBe(200);
    expect(res.body.pending).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.blocked).toBe('number');
    expect(res.body.total).toBe(res.body.pending + res.body.blocked);
  });
});

describe('管理API: order-linking-jobs手動再送・skip(本番安定化指示書Stage5・8.6)', () => {
  const originalFlag = process.env.SENNOKUNI_INTEGRATION_ENABLED;
  const createdUserIds: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.SENNOKUNI_INTEGRATION_ENABLED = originalFlag;
    await prisma.setting.deleteMany({
      where: { key: { in: ['sennokuni_hmac_key_id', 'sennokuni_hmac_secret', 'sennokuni_agency_hub_base_url'] } },
    });
  });

  afterAll(async () => {
    await prisma.orderLinkingJob.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it('Feature Flag無効時は手動再送しても404(実送信を行わない)', async () => {
    delete process.env.SENNOKUNI_INTEGRATION_ENABLED;
    const { agent } = await createAdminAgent(app);
    const user = await createLinkingUser('retry-disabled');
    createdUserIds.push(user.id);
    const job = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));
    await prisma.orderLinkingJob.update({ where: { id: job.id }, data: { status: 'dead' } });

    const res = await agent.post(`/api/admin/order-linking-jobs/${job.id}/retry`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(404);
  });

  it('Feature Flag有効時、dead状態のジョブを再送でき成功すればsucceededになる', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ common_user_id: 'cu_retry_route_test' }) }));

    const { agent } = await createAdminAgent(app);
    const user = await createLinkingUser('retry-success');
    createdUserIds.push(user.id);
    const job = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));
    await prisma.orderLinkingJob.update({ where: { id: job.id }, data: { status: 'dead' } });

    const res = await agent.post(`/api/admin/order-linking-jobs/${job.id}/retry`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('succeeded');
  });

  it('存在しないIDの再送は404', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .post('/api/admin/order-linking-jobs/00000000-0000-0000-0000-000000000000/retry')
      .set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(404);
  });

  it('閲覧専用管理者の再送は403(READONLY_ADMIN)', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    const { agent } = await createViewerAgent();
    const user = await createLinkingUser('retry-viewer');
    createdUserIds.push(user.id);
    const job = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));

    const res = await agent.post(`/api/admin/order-linking-jobs/${job.id}/retry`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('READONLY_ADMIN');
  });

  it('skipはFeature Flagに関わらず実送信せずstatus=skippedにできる', async () => {
    delete process.env.SENNOKUNI_INTEGRATION_ENABLED;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { agent } = await createAdminAgent(app);
    const user = await createLinkingUser('skip');
    createdUserIds.push(user.id);
    const job = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));
    await prisma.orderLinkingJob.update({ where: { id: job.id }, data: { status: 'blocked', blockedReason: 'common_user_unresolved' } });

    const res = await agent.post(`/api/admin/order-linking-jobs/${job.id}/skip`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    const after = await prisma.orderLinkingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('skipped');
    expect(after.blockedReason).toBeNull();
  });

  it('processing中のジョブはskipできない(外部送信済みの可能性があるため)', async () => {
    const { agent } = await createAdminAgent(app);
    const user = await createLinkingUser('skip-processing');
    createdUserIds.push(user.id);
    const job = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));
    await prisma.orderLinkingJob.update({ where: { id: job.id }, data: { status: 'processing', processingToken: 'tok' } });

    const res = await agent.post(`/api/admin/order-linking-jobs/${job.id}/skip`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(404);
  });

  it('閲覧専用管理者のskipは403(READONLY_ADMIN)', async () => {
    const { agent } = await createViewerAgent();
    const user = await createLinkingUser('skip-viewer');
    createdUserIds.push(user.id);
    const job = await prisma.$transaction((tx) => enqueueCommonUserResolveJob(tx, { userId: user.id }));

    const res = await agent.post(`/api/admin/order-linking-jobs/${job.id}/skip`).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('READONLY_ADMIN');
  });
});
