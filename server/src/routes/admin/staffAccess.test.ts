import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

async function createStaffAgent(name: string) {
  const email = `staff-access-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const user = await prisma.user.create({
    data: { name, email, passwordHash: await bcrypt.hash('staffpassword1', 10), role: 'staff' },
  });
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'staffpassword1' });
  return { agent, userId: user.id };
}

// 仕様書外の拡張: スタッフ(staff)は日次業務系のみ利用でき、管理者アカウント管理・決済/メール設定・
// 監査ログ・紹介リンク発行・クーポン管理・代理店関連機能は403で弾かれることを確認する。
describe('管理API: スタッフ権限のアクセス制限(仕様書外の拡張)', () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: 'staff-access-test' } } });
    await prisma.$disconnect();
  });

  it('スタッフは日次業務系(ダッシュボード・商品・注文・NFT発行・ウォレット未登録・お知らせ)を閲覧できる', async () => {
    const { agent } = await createStaffAgent('日次業務スタッフ');

    for (const path of ['/dashboard', '/products', '/orders', '/nft-issues', '/wallet-missing', '/notices']) {
      const res = await agent.get(`/api/admin${path}`);
      expect(res.status, `${path} should be 200 for staff`).toBe(200);
    }
  });

  it('スタッフは管理者専用機能に403でアクセスできない(FORBIDDEN)', async () => {
    const { agent } = await createStaffAgent('制限確認スタッフ');

    for (const path of [
      '/admin-users',
      '/audit-logs',
      '/agencies',
      '/referral-links',
      '/referrals/summary',
      '/settings',
      '/bank-transfer-settings',
      '/legal',
      '/coupons',
      '/stripe-events',
      '/integration-outbox',
    ]) {
      const res = await agent.get(`/api/admin${path}`);
      expect(res.status, `${path} should be 403 for staff`).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('スタッフは商品管理等の書き込み操作も行える(閲覧専用管理者とは異なる)', async () => {
    const { agent } = await createStaffAgent('書き込み確認スタッフ');

    const res = await agent
      .post('/api/admin/notices')
      .set('Origin', TEST_ORIGIN)
      .send({ title: 'staff-access-test お知らせ', body: '本文' });

    expect(res.status).toBe(201);

    await prisma.notice.deleteMany({ where: { title: 'staff-access-test お知らせ' } });
  });
});
