import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();
const MARK = 'admin-coupon-test';

describe('管理API: クーポン管理(仕様書外の拡張)', () => {
  afterAll(async () => {
    await prisma.couponAgency.deleteMany({ where: { coupon: { code: { contains: MARK } } } });
    await prisma.couponProduct.deleteMany({ where: { coupon: { code: { contains: MARK } } } });
    await prisma.coupon.deleteMany({ where: { code: { contains: MARK } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('固定額クーポンを作成できる', async () => {
    const { agent } = await createAdminAgent(app);

    const res = await agent
      .post('/api/admin/coupons')
      .set('Origin', TEST_ORIGIN)
      .send({ name: `${MARK}固定額`, discountType: 'fixed', discountAmount: 3000 });

    expect(res.status).toBe(201);
    expect(res.body.coupon.code).toBeTruthy();
    expect(res.body.coupon.discountAmount).toBe(3000);
    expect(res.body.coupon.isActive).toBe(true);
  });

  it('割引率が100を超える場合はVALIDATION_ERROR', async () => {
    const { agent } = await createAdminAgent(app);

    const res = await agent
      .post('/api/admin/coupons')
      .set('Origin', TEST_ORIGIN)
      .send({ name: `${MARK}不正`, discountType: 'percentage', discountPercentage: 150 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('手入力したコードが重複する場合はCOUPON_CODE_ALREADY_EXISTS', async () => {
    const { agent } = await createAdminAgent(app);
    const code = `${MARK}-DUP-${Date.now()}`;

    const first = await agent
      .post('/api/admin/coupons')
      .set('Origin', TEST_ORIGIN)
      .send({ name: `${MARK}1`, code, discountType: 'fixed', discountAmount: 1000 });
    expect(first.status).toBe(201);

    const second = await agent
      .post('/api/admin/coupons')
      .set('Origin', TEST_ORIGIN)
      .send({ name: `${MARK}2`, code, discountType: 'fixed', discountAmount: 1000 });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('COUPON_CODE_ALREADY_EXISTS');
  });

  it('作成したクーポンを無効化・有効化できる', async () => {
    const { agent } = await createAdminAgent(app);

    const created = await agent
      .post('/api/admin/coupons')
      .set('Origin', TEST_ORIGIN)
      .send({ name: `${MARK}トグル`, discountType: 'fixed', discountAmount: 1000 });
    const couponId = created.body.coupon.id;

    const deactivated = await agent.post(`/api/admin/coupons/${couponId}/deactivate`).set('Origin', TEST_ORIGIN);
    expect(deactivated.body.coupon.isActive).toBe(false);

    const activated = await agent.post(`/api/admin/coupons/${couponId}/activate`).set('Origin', TEST_ORIGIN);
    expect(activated.body.coupon.isActive).toBe(true);
  });

  it('削除は論理削除であり、一覧・詳細から見えなくなる', async () => {
    const { agent } = await createAdminAgent(app);

    const created = await agent
      .post('/api/admin/coupons')
      .set('Origin', TEST_ORIGIN)
      .send({ name: `${MARK}削除`, discountType: 'fixed', discountAmount: 1000 });
    const couponId = created.body.coupon.id;

    const deleteRes = await agent.delete(`/api/admin/coupons/${couponId}`).set('Origin', TEST_ORIGIN);
    expect(deleteRes.status).toBe(204);

    const getRes = await agent.get(`/api/admin/coupons/${couponId}`);
    expect(getRes.status).toBe(404);

    const stillInDb = await prisma.coupon.findUnique({ where: { id: couponId } });
    expect(stillInDb).not.toBeNull();
    expect(stillInDb?.deletedAt).not.toBeNull();
  });

  it('閲覧専用管理者は作成できない', async () => {
    const email = `admin-test-viewer-${Date.now()}@example.com`;
    const bcrypt = await import('bcryptjs');
    await prisma.user.create({
      data: { name: '閲覧専用', email, passwordHash: await bcrypt.hash('viewerpassword1', 10), role: 'admin_viewer' },
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'viewerpassword1' });

    const res = await agent
      .post('/api/admin/coupons')
      .set('Origin', TEST_ORIGIN)
      .send({ name: `${MARK}閲覧`, discountType: 'fixed', discountAmount: 1000 });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('READONLY_ADMIN');
  });
});
