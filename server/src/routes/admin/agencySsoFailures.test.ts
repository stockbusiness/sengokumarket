import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

// 仕様書外の拡張(2026-10・緊急障害対応): 代理店SSOログイン失敗ログの一覧API。
describe('管理API: agency-sso-failures一覧', () => {
  const sub = `admin-agency-sso-failures-route-test-${Date.now()}`;

  afterAll(async () => {
    await prisma.agencySsoLoginFailureLog.deleteMany({ where: { detail: { path: ['sub'], equals: sub } } });
    await prisma.$disconnect();
  });

  it('未認証は401になる', async () => {
    const res = await request(app).get('/api/admin/agency-sso-failures');
    expect(res.status).toBe(401);
  });

  it('管理者は失敗ログを新しい順に取得できる', async () => {
    await prisma.agencySsoLoginFailureLog.create({
      data: { errorCode: 'agency_not_linked', detail: { sub, hasActorEmailClaim: false, hasContactEmailClaim: false } },
    });
    await prisma.agencySsoLoginFailureLog.create({
      data: { errorCode: 'agency_not_linked', detail: { sub, agencyNameClaim: 'テスト代理店', hasActorEmailClaim: true } },
    });

    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/agency-sso-failures').set('Origin', TEST_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.failures.length).toBeGreaterThanOrEqual(2);
    expect(res.body.failures[0].errorCode).toBe('agency_not_linked');
    // 新しい順(2件目に作成した方が先頭)。
    expect(res.body.failures[0].detail.agencyNameClaim).toBe('テスト代理店');
  });
});
