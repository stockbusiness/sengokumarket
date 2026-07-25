import { afterAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';
import { setSetting } from '../../services/settings';

const app = createApp();

async function createViewerAgent() {
  const email = `integration-preflight-viewer-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await prisma.user.create({
    data: { name: '閲覧専用管理者', email, passwordHash: await bcrypt.hash('viewerpassword1', 10), role: 'admin_viewer' },
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'viewerpassword1' });
  return agent;
}

// 本番安定化指示書Stage8(11.3「Preflight」・11.4「段階化」・11.5「production変更が
// 監査ログへ残る」「正式設定不足でproduction有効化不可」)。
describe('管理API: 外部連携Preflight・段階(本番安定化指示書Stage8)', () => {
  const originalFlag = process.env.SENNOKUNI_INTEGRATION_ENABLED;

  afterEach(async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = originalFlag;
    await prisma.setting.deleteMany({
      where: {
        key: {
          in: [
            'sennokuni_hmac_key_id',
            'sennokuni_hmac_secret',
            'sennokuni_agency_hub_base_url',
            'sennokuni_integration_stage',
          ],
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: 'integration-preflight-viewer-test' } } });
    await prisma.$disconnect();
  });

  it('未認証は401になる', async () => {
    const res = await request(app).get('/api/admin/integration-preflight');
    expect(res.status).toBe(401);
  });

  it('管理者はpreflightレポートを取得できる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/integration-preflight');
    expect(res.status).toBe(200);
    expect(res.body.report).toBeTruthy();
    expect(res.body.report.stage).toBe('disabled');
    expect(typeof res.body.report.readyForActivation).toBe('boolean');
  });

  it('閲覧専用管理者もpreflightは閲覧できる', async () => {
    const agent = await createViewerAgent();
    const res = await agent.get('/api/admin/integration-preflight');
    expect(res.status).toBe(200);
  });

  it('GET /integration-stageは現在の段階を返す', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/integration-stage');
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('disabled');
  });

  it('不正なstage値は400になる', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.put('/api/admin/integration-stage').set('Origin', TEST_ORIGIN).send({ stage: 'not-a-real-stage' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('dry_runへの変更は必須設定が揃っていなくても許可される', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.put('/api/admin/integration-stage').set('Origin', TEST_ORIGIN).send({ stage: 'dry_run' });
    expect(res.status).toBe(200);
    // マスタースイッチ(env var)がfalseのため、実際の有効stageはdisabledのまま。
    expect(res.body.stage).toBe('disabled');
  });

  it('11.5「正式設定不足でproduction有効化不可」: 必須設定が不足している場合、productionへの変更は422で拒否される', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.put('/api/admin/integration-stage').set('Origin', TEST_ORIGIN).send({ stage: 'production' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PREFLIGHT_NOT_READY');
  });

  it('必須設定・HMAC自己診断が揃っていればproductionへ変更でき、監査ログに記録される', async () => {
    await setSetting('sennokuni_hmac_key_id', 'key-123');
    await setSetting('sennokuni_hmac_secret', 'secret-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://agency-hub.example.com');

    const { agent, userId } = await createAdminAgent(app);
    const res = await agent.put('/api/admin/integration-stage').set('Origin', TEST_ORIGIN).send({ stage: 'production' });
    expect(res.status).toBe(200);

    const auditLog = await prisma.adminAuditLog.findFirst({
      where: { actorUserId: userId, path: '/api/admin/integration-stage', method: 'PUT' },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditLog).toBeTruthy();
    expect((auditLog!.requestBody as Record<string, unknown>).stage).toBe('production');
  });

  it('閲覧専用管理者はstage変更が403(READONLY_ADMIN)', async () => {
    const agent = await createViewerAgent();
    const res = await agent.put('/api/admin/integration-stage').set('Origin', TEST_ORIGIN).send({ stage: 'dry_run' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('READONLY_ADMIN');
  });
});
