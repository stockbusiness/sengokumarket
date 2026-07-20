import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { setSetting } from '../../services/settings';

const sendAgencyAccountSetupEmail = vi.fn(async (..._args: unknown[]) => {});
const sendAgencyAccessGrantedEmail = vi.fn(async (..._args: unknown[]) => {});

vi.mock('../../services/mailTemplates', () => ({
  sendAgencyAccountSetupEmail: (...args: unknown[]) => sendAgencyAccountSetupEmail(...args),
  sendAgencyAccessGrantedEmail: (...args: unknown[]) => sendAgencyAccessGrantedEmail(...args),
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

  it('APIキーがない場合は401(ok:falseのエンベロープで返す。外部開発者向け連携ガイドv3.6.78-draft)', async () => {
    const res = await request(app).get('/api/integrations/agencies');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('API_KEY_REQUIRED');
  });

  it('APIキーが誤っている場合は401(INVALID_API_KEY)', async () => {
    const res = await request(app).get('/api/integrations/agencies').set('x-api-key', 'wrong-key');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INVALID_API_KEY');
  });

  it('Authorization: Bearerヘッダーでも認証できる', async () => {
    const res = await request(app).get('/api/integrations/agencies').set('Authorization', `Bearer ${API_KEY}`);
    expect(res.status).toBe(200);
  });

  it('event=connection_testは代理店データを保存せず200を返す(接続テスト)', async () => {
    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ event: 'connection_test', dry_run: true, source: 'sengoku-ai', external_id: '__connection_test__' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const saved = await prisma.agency.findUnique({ where: { externalId: '__connection_test__' } });
    expect(saved).toBeNull();
  });

  it('dry_run=trueのみでも代理店データを保存せず200を返す', async () => {
    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ dry_run: true, external_id: 'integration-test-dry-run' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const saved = await prisma.agency.findUnique({ where: { externalId: 'integration-test-dry-run' } });
    expect(saved).toBeNull();
  });

  it('未対応のイベント種別(共通顧客HUB関連等)は200で受理するが処理はスキップする', async () => {
    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ event: 'common_user.merged', common_user_id: 'cu_target' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.processed).toBe(false);
    expect(res.body.event).toBe('common_user.merged');
  });

  it('lead_createdイベントも200で受理するが代理店としては保存しない', async () => {
    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ event: 'lead_created', external_id: 'integration-test-lead-should-not-be-saved' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.processed).toBe(false);

    const saved = await prisma.agency.findUnique({ where: { externalId: 'integration-test-lead-should-not-be-saved' } });
    expect(saved).toBeNull();
  });

  it('既知の代理店ライフサイクル系イベント(admin_updated等)は通常のupsertとして処理される', async () => {
    const externalId = `integration-test-lifecycle-${Date.now()}`;
    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ event: 'admin_updated', external_id: externalId, name: 'ライフサイクルイベントテスト' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.name).toBe('ライフサイクルイベントテスト');
  });

  it('親代理店→子代理店の順で作成し、ツリー構造を取得できる', async () => {
    const parentExternalId = `integration-test-parent-${Date.now()}`;
    const childExternalId = `integration-test-child-${Date.now()}`;

    const parentRes = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: parentExternalId, name: '親代理店テスト', default_commission_rate: 15 });
    expect(parentRes.status).toBe(201);
    expect(parentRes.body.ok).toBe(true);
    expect(parentRes.body.code).toMatch(/^AG\d+/);

    const childRes = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: childExternalId, name: '子代理店テスト', parent_external_id: parentExternalId });
    expect(childRes.status).toBe(201);
    expect(childRes.body.parent_external_id).toBe(parentExternalId);

    const detailRes = await request(app)
      .get(`/api/integrations/agencies/${parentExternalId}`)
      .set('x-api-key', API_KEY);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.agency.child_external_ids).toContain(childExternalId);
  });

  it('存在しないparent_external_idはエラーにせず保存され、親が後から届くと自動的に再紐付けされる', async () => {
    const childExternalId = `integration-test-orphan-${Date.now()}`;
    const parentExternalId = `integration-test-orphan-parent-${Date.now()}`;

    const childRes = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: childExternalId, name: 'orphan', parent_external_id: parentExternalId });
    expect(childRes.status).toBe(201);
    expect(childRes.body.ok).toBe(true);
    // 未解決の間は受け取ったparent_external_idをそのまま返す
    expect(childRes.body.parent_external_id).toBe(parentExternalId);

    const childBeforeLink = await prisma.agency.findUniqueOrThrow({ where: { externalId: childExternalId } });
    expect(childBeforeLink.parentAgencyId).toBeNull();

    const parentRes = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: parentExternalId, name: 'orphan-parent' });
    expect(parentRes.status).toBe(201);

    const childAfterLink = await prisma.agency.findUniqueOrThrow({ where: { externalId: childExternalId } });
    expect(childAfterLink.parentAgencyId).toBe(parentRes.body.id);
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
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.name).toBe('更新後');

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
    expect(res.body.login_provisioned).toBe(true);
    expect(sendAgencyAccountSetupEmail).toHaveBeenCalledTimes(1);

    const user = await prisma.user.findUnique({ where: { email: loginEmail } });
    expect(user?.role).toBe('agency');
    expect(user?.agencyId).toBe(res.body.id);

    // 同じ代理店に対して再度login_emailを送っても二重作成されない
    sendAgencyAccountSetupEmail.mockClear();
    const second = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: externalId, name: 'ログイン代理店', login_email: loginEmail });
    expect(second.body.login_provisioned).toBe(false);
    expect(sendAgencyAccountSetupEmail).not.toHaveBeenCalled();
  });

  it('既に代理店へ永久帰属している会員のメールをlogin_emailに指定すると、既存アカウントが昇格し上位代理店を継承する', async () => {
    const referrerExternalId = `integration-test-referrer-${Date.now()}`;
    const referrerRes = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: referrerExternalId, name: '元の紹介代理店' });
    expect(referrerRes.status).toBe(201);
    const referrerAgencyId = referrerRes.body.id;

    const memberEmail = `integration-agency-test-member-${Date.now()}@example.com`;
    const member = await prisma.user.create({
      data: {
        name: '購入者太郎',
        email: memberEmail,
        passwordHash: 'existing-password-hash',
        role: 'user',
        referredByAgencyId: referrerAgencyId,
        referredByCode: 'SGI-TEST',
        referredAt: new Date(),
      },
    });

    const newAgencyExternalId = `integration-test-promoted-${Date.now()}`;
    sendAgencyAccountSetupEmail.mockClear();
    sendAgencyAccessGrantedEmail.mockClear();
    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: newAgencyExternalId, name: 'インフルエンサー昇格代理店', login_email: memberEmail });

    expect(res.status).toBe(201);
    expect(res.body.login_provisioned).toBe(true);
    expect(res.body.parent_external_id).toBe(referrerExternalId);
    expect(sendAgencyAccessGrantedEmail).toHaveBeenCalledWith(memberEmail, '購入者太郎');
    expect(sendAgencyAccountSetupEmail).not.toHaveBeenCalled();

    const updatedMember = await prisma.user.findUnique({ where: { id: member.id } });
    expect(updatedMember?.role).toBe('agency');
    expect(updatedMember?.agencyId).toBe(res.body.id);
    // 既存のパスワードはそのまま(仮パスワードへの上書きはされない)
    expect(updatedMember?.passwordHash).toBe('existing-password-hash');
  });

  it('parent_external_idを明示指定した場合は、永久帰属している代理店より明示指定が優先される', async () => {
    const referrerExternalId = `integration-test-referrer2-${Date.now()}`;
    const referrerRes = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: referrerExternalId, name: '元の紹介代理店2' });
    const referrerAgencyId = referrerRes.body.id;

    const explicitParentExternalId = `integration-test-explicit-parent-${Date.now()}`;
    await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: explicitParentExternalId, name: '明示指定する親代理店' });

    const memberEmail = `integration-agency-test-member2-${Date.now()}@example.com`;
    await prisma.user.create({
      data: {
        name: '購入者次郎',
        email: memberEmail,
        passwordHash: 'x',
        role: 'user',
        referredByAgencyId: referrerAgencyId,
      },
    });

    const newAgencyExternalId = `integration-test-promoted2-${Date.now()}`;
    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({
        external_id: newAgencyExternalId,
        name: '明示指定テスト代理店',
        parent_external_id: explicitParentExternalId,
        login_email: memberEmail,
      });

    expect(res.status).toBe(201);
    expect(res.body.parent_external_id).toBe(explicitParentExternalId);
  });

  it('既に管理者・代理店として使われているメールアドレスをlogin_emailに指定すると409', async () => {
    const takenEmail = `integration-agency-test-taken-${Date.now()}@example.com`;
    await prisma.user.create({
      data: { name: '既存の代理店担当者', email: takenEmail, passwordHash: 'x', role: 'agency' },
    });

    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: `integration-test-conflict-${Date.now()}`, name: '衝突テスト代理店', login_email: takenEmail });

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
  });

  it('contact_name未指定時はnameが使われる', async () => {
    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: `integration-test-contactname-${Date.now()}`, name: 'integration-test-名前会社' });
    expect(res.status).toBe(201);
    expect(res.body.contact_name).toBe('integration-test-名前会社');
  });

  it('parent_external_idが空文字の場合は本部直下扱いになる', async () => {
    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: `integration-test-rootempty-${Date.now()}`, name: 'root', parent_external_id: '' });
    expect(res.status).toBe(201);
    expect(res.body.parent_external_id).toBeNull();
  });

  it('自分自身を親に指定すると422', async () => {
    const externalId = `integration-test-selfparent-${Date.now()}`;
    await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: externalId, name: 'self' });

    const res = await request(app)
      .post('/api/integrations/agencies')
      .set('x-api-key', API_KEY)
      .send({ external_id: externalId, name: 'self', parent_external_id: externalId });
    expect(res.status).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('自分の配下代理店を親に指定すると422(循環防止)', async () => {
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
    expect(res.status).toBe(422);
  });

  it('GET /?external_id=でもクエリ形式で詳細取得できる', async () => {
    const externalId = `integration-test-queryform-${Date.now()}`;
    await request(app).post('/api/integrations/agencies').set('x-api-key', API_KEY).send({ external_id: externalId, name: 'q' });

    const res = await request(app).get(`/api/integrations/agencies?external_id=${externalId}`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.agency.external_id).toBe(externalId);
  });
});
