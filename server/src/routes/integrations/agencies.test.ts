import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { setSetting } from '../../services/settings';

const sendAgencyAccountSetupEmail = vi.fn(async (..._args: unknown[]) => {});

vi.mock('../../services/mailTemplates', () => ({
  sendAgencyAccountSetupEmail: (...args: unknown[]) => sendAgencyAccountSetupEmail(...args),
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendPurchaseCompleteEmail: vi.fn(async () => {}),
  sendGuestPasswordSetupEmail: vi.fn(async () => {}),
}));

const app = createApp();
const API_KEY = 'integration-test-api-key-12345';

describe('外部代理店システム連携API', () => {
  beforeAll(async () => {
    await setSetting('agency_api_key', API_KEY);
  });

  afterAll(async () => {
    await prisma.passwordResetToken.deleteMany({ where: { user: { email: { contains: 'integration-agency-test' } } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'integration-agency-test' } } });
    await prisma.agency.deleteMany({ where: { externalId: { contains: 'integration-test' } } });
    await prisma.$disconnect();
  });

  it('APIキーがない場合は401', async () => {
    const res = await request(app).get('/api/integrations/agencies');
    expect(res.status).toBe(401);
  });

  it('APIキーが誤っている場合は401', async () => {
    const res = await request(app).get('/api/integrations/agencies').set('x-api-key', 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('親代理店→子代理店の順で作成し、ツリー構造を取得できる', async () => {
    const parentExternalId = `integration-test-parent-${Date.now()}`;
    const childExternalId = `integration-test-child-${Date.now()}`;

    const parentRes = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: parentExternalId, name: '親代理店テスト', default_commission_rate: 15 });
    expect(parentRes.status).toBe(201);
    expect(parentRes.body.agency.code).toMatch(/^AG\d+/);

    const childRes = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: childExternalId, name: '子代理店テスト', parent_external_id: parentExternalId });
    expect(childRes.status).toBe(201);
    expect(childRes.body.agency.parent_external_id).toBe(parentExternalId);

    const detailRes = await request(app)
      .get(`/api/integrations/agencies/${parentExternalId}`)
      .set('x-api-key', API_KEY);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.agency.child_external_ids).toContain(childExternalId);
  });

  it('存在しないparent_external_idは404', async () => {
    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: `integration-test-orphan-${Date.now()}`, name: 'orphan', parent_external_id: 'nonexistent' });
    expect(res.status).toBe(404);
  });

  it('同じexternal_idで再送すると更新になり、二重作成されない', async () => {
    const externalId = `integration-test-upsert-${Date.now()}`;
    const first = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: externalId, name: '更新前' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: externalId, name: '更新後' });
    expect(second.status).toBe(200);
    expect(second.body.agency.id).toBe(first.body.agency.id);
    expect(second.body.agency.name).toBe('更新後');

    const count = await prisma.agency.count({ where: { externalId } });
    expect(count).toBe(1);
  });

  it('login_emailを指定するとログイン用ユーザーが作成され、案内メールが送信される', async () => {
    const externalId = `integration-test-login-${Date.now()}`;
    const loginEmail = `integration-agency-test-${Date.now()}@example.com`;

    sendAgencyAccountSetupEmail.mockClear();
    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: externalId, name: 'ログイン代理店', login_email: loginEmail });

    expect(res.status).toBe(201);
    expect(res.body.agency.login_provisioned).toBe(true);
    expect(sendAgencyAccountSetupEmail).toHaveBeenCalledTimes(1);

    const user = await prisma.user.findUnique({ where: { email: loginEmail } });
    expect(user?.role).toBe('agency');
    expect(user?.agencyId).toBe(res.body.agency.id);

    // 同じ代理店に対して再度login_emailを送っても二重作成されない
    sendAgencyAccountSetupEmail.mockClear();
    const second = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: externalId, name: 'ログイン代理店', login_email: loginEmail });
    expect(second.body.agency.login_provisioned).toBe(false);
    expect(sendAgencyAccountSetupEmail).not.toHaveBeenCalled();
  });

  it('contact_name未指定時はnameが使われる', async () => {
    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: `integration-test-contactname-${Date.now()}`, name: 'integration-test-名前会社' });
    expect(res.status).toBe(201);
    expect(res.body.agency.contact_name).toBe('integration-test-名前会社');
  });

  it('parent_external_idが空文字の場合は本部直下扱いになる', async () => {
    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: `integration-test-rootempty-${Date.now()}`, name: 'root', parent_external_id: '' });
    expect(res.status).toBe(201);
    expect(res.body.agency.parent_external_id).toBeNull();
  });

  it('自分自身を親に指定すると400', async () => {
    const externalId = `integration-test-selfparent-${Date.now()}`;
    await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: externalId, name: 'self' });

    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: externalId, name: 'self', parent_external_id: externalId });
    expect(res.status).toBe(400);
  });

  it('自分の配下代理店を親に指定すると400(循環防止)', async () => {
    const grandparent = `integration-test-cycle-gp-${Date.now()}`;
    const parent = `integration-test-cycle-p-${Date.now()}`;
    const child = `integration-test-cycle-c-${Date.now()}`;

    await request(app).post('/api/integrations/agencies').set('x-api-key', API_KEY).send({ external_id: grandparent, name: 'gp' });
    await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: parent, name: 'p', parent_external_id: grandparent });
    await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: child, name: 'c', parent_external_id: parent });

    // grandparentの親をchildにしようとする = 循環
    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: grandparent, name: 'gp', parent_external_id: child });
    expect(res.status).toBe(400);
  });

  it('GET /?external_id=でもクエリ形式で詳細取得できる', async () => {
    const externalId = `integration-test-queryform-${Date.now()}`;
    await request(app).post('/api/integrations/agencies').set('x-api-key', API_KEY).send({ external_id: externalId, name: 'q' });

    const res = await request(app).get(`/api/integrations/agencies?external_id=${externalId}`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.agency.external_id).toBe(externalId);
  });
});
