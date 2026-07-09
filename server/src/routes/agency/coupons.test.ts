import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { generateAgencyCode } from '../../services/referralCodeGenerator';
import { TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();
const MARK = 'agency-coupon-test';

async function createAgencyAgent(name: string) {
  const agency = await prisma.$transaction(async (tx) => {
    const code = await generateAgencyCode(tx);
    return tx.agency.create({ data: { name, code, defaultCommissionRate: 10 } });
  });

  const email = `${MARK}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await prisma.user.create({
    data: { name, email, passwordHash: await bcrypt.hash('agencypassword1', 10), role: 'agency', agencyId: agency.id },
  });

  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'agencypassword1' });

  return { agent, agency };
}

describe('代理店ポータル: クーポン(仕様書外の拡張)', () => {
  afterAll(async () => {
    await prisma.referralLink.deleteMany({ where: { agency: { name: { contains: MARK } } } });
    await prisma.couponAgency.deleteMany({ where: { coupon: { code: { contains: MARK } } } });
    await prisma.coupon.deleteMany({ where: { code: { contains: MARK } } });
    await prisma.user.deleteMany({ where: { email: { contains: MARK } } });
    await prisma.agency.deleteMany({ where: { name: { contains: MARK } } });
    await prisma.$disconnect();
  });

  it('全代理店対象のクーポンは一覧に表示される', async () => {
    const { agent } = await createAgencyAgent(`${MARK}-全体`);
    const coupon = await prisma.coupon.create({
      data: { code: `${MARK}-ALL-${Date.now()}`, name: '全代理店クーポン', discountType: 'fixed', discountAmount: 1000 },
    });

    const res = await agent.get('/api/agency/coupons/available');
    expect(res.status).toBe(200);
    expect(res.body.coupons.some((c: { id: string }) => c.id === coupon.id)).toBe(true);
  });

  it('他代理店限定のクーポンは一覧に表示されない', async () => {
    const { agent } = await createAgencyAgent(`${MARK}-対象外`);
    const { agency: otherAgency } = await createAgencyAgent(`${MARK}-別枠`);

    const coupon = await prisma.coupon.create({
      data: { code: `${MARK}-LIMITED-${Date.now()}`, name: '限定クーポン', discountType: 'fixed', discountAmount: 1000, agencyScopeType: 'include' },
    });
    await prisma.couponAgency.create({ data: { couponId: coupon.id, agencyId: otherAgency.id } });

    const res = await agent.get('/api/agency/coupons/available');
    expect(res.body.coupons.some((c: { id: string }) => c.id === coupon.id)).toBe(false);
  });

  it('自代理店が利用可能なクーポンを紹介URL発行時に指定できる', async () => {
    const { agent, agency } = await createAgencyAgent(`${MARK}-発行`);
    const coupon = await prisma.coupon.create({
      data: {
        code: `${MARK}-ISSUE-${Date.now()}`,
        name: '発行時クーポン',
        discountType: 'fixed',
        discountAmount: 2000,
        agencyScopeType: 'include',
      },
    });
    await prisma.couponAgency.create({ data: { couponId: coupon.id, agencyId: agency.id } });

    const res = await agent
      .post('/api/agency/referral-links')
      .set('Origin', TEST_ORIGIN)
      .send({ coupon_id: coupon.id, landing_path: '/products/test' });

    expect(res.status).toBe(201);
    expect(res.body.referralLink.couponId).toBe(coupon.id);
  });

  it('他代理店限定のクーポンを指定しようとするとCOUPON_NOT_ELIGIBLE', async () => {
    const { agent } = await createAgencyAgent(`${MARK}-拒否`);
    const { agency: otherAgency } = await createAgencyAgent(`${MARK}-拒否別枠`);

    const coupon = await prisma.coupon.create({
      data: {
        code: `${MARK}-DENY-${Date.now()}`,
        name: '他代理店限定',
        discountType: 'fixed',
        discountAmount: 2000,
        agencyScopeType: 'include',
      },
    });
    await prisma.couponAgency.create({ data: { couponId: coupon.id, agencyId: otherAgency.id } });

    const res = await agent
      .post('/api/agency/referral-links')
      .set('Origin', TEST_ORIGIN)
      .send({ coupon_id: coupon.id, landing_path: '/products/test' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COUPON_NOT_ELIGIBLE');
  });
});
