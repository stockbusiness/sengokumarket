import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { generateAgencyCode } from '../../services/referralCodeGenerator';
import { TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

async function createAgencyAgent(name: string) {
  const agency = await prisma.$transaction(async (tx) => {
    const code = await generateAgencyCode(tx);
    return tx.agency.create({ data: { name, code, defaultCommissionRate: 10 } });
  });

  const email = `agency-portal-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await prisma.user.create({
    data: { name, email, passwordHash: await bcrypt.hash('agencypassword1', 10), role: 'agency', agencyId: agency.id },
  });

  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'agencypassword1' });

  return { agent, agency };
}

describe('代理店ポータル: 紹介URL発行', () => {
  afterAll(async () => {
    await prisma.referralLink.deleteMany({ where: { agency: { name: { contains: 'agency-portal-test' } } } });
    await prisma.influencer.deleteMany({ where: { name: { contains: 'agency-portal-test' } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'agency-portal-test' } } });
    await prisma.agency.deleteMany({ where: { name: { contains: 'agency-portal-test' } } });
    await prisma.$disconnect();
  });

  it('一般ユーザーは403', async () => {
    const email = `agency-portal-test-general-${Date.now()}@example.com`;
    const agent = request.agent(app);
    await agent.post('/api/auth/register').set('Origin', TEST_ORIGIN).send({ name: '一般', email, password: 'password123' });

    const res = await agent.get('/api/agency/referral-links');
    expect(res.status).toBe(403);
  });

  it('自代理店の紹介URLを発行・一覧取得できる', async () => {
    const { agent } = await createAgencyAgent('agency-portal-test-A');

    const created = await agent
      .post('/api/agency/referral-links')
      .set('Origin', TEST_ORIGIN)
      .send({ influencer: { new_name: 'agency-portal-test-influencer' }, commission_rate: null });

    expect(created.status).toBe(201);
    expect(created.body.referralLink.code).toMatch(/^SGI\d+/);
    expect(created.body.referralLink.resolvedCommissionRate).toBe(10);
    // 仕様書外の拡張(2026-07-22): 商品ごとの個別リンクではなく商品一覧ページへ統一する。
    expect(created.body.referralLink.url).toContain('/products?ref=');

    const list = await agent.get('/api/agency/referral-links');
    expect(list.status).toBe(200);
    expect(list.body.referralLinks.some((l: { id: string }) => l.id === created.body.referralLink.id)).toBe(true);
  });

  it('他代理店の紹介URLは一覧に出ず、他代理店のインフルエンサーは指定できない', async () => {
    const { agent: agentA } = await createAgencyAgent('agency-portal-test-B1');
    const { agent: agentB, agency: agencyB } = await createAgencyAgent('agency-portal-test-B2');

    const influencerB = await prisma.influencer.create({
      data: { agencyId: agencyB.id, name: 'agency-portal-test-influencer-b', code: `INFTEST${Date.now()}` },
    });

    const forbidden = await agentA
      .post('/api/agency/referral-links')
      .set('Origin', TEST_ORIGIN)
      .send({ influencer: { id: influencerB.id }, commission_rate: null });
    expect(forbidden.status).toBe(404);

    const createdB = await agentB
      .post('/api/agency/referral-links')
      .set('Origin', TEST_ORIGIN)
      .send({ influencer: null, commission_rate: null });
    expect(createdB.status).toBe(201);

    const listA = await agentA.get('/api/agency/referral-links');
    expect(listA.body.referralLinks.some((l: { id: string }) => l.id === createdB.body.referralLink.id)).toBe(false);
  });
});
