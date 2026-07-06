import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

describe('管理API: Stripe/Resend設定(仕様書外の拡張)', () => {
  afterAll(async () => {
    await prisma.setting.deleteMany({ where: { key: 'mail_from' } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('一般ユーザーは403', async () => {
    const email = `admin-settings-test-user-${Date.now()}@example.com`;
    const agent = request.agent(app);
    await agent.post('/api/auth/register').set('Origin', TEST_ORIGIN).send({ name: '一般', email, password: 'password123' });
    const res = await agent.get('/api/admin/settings');
    expect(res.status).toBe(403);
  });

  it('未設定はconfigured=falseを返す', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/settings');
    expect(res.status).toBe(200);
    expect(res.body.settings.mail_from.configured).toBe(false);
  });

  it('設定するとマスクされた値が返る(生の値は含まれない)', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .put('/api/admin/settings')
      .set('Origin', TEST_ORIGIN)
      .send({ mail_from: 'noreply@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.settings.mail_from.configured).toBe(true);
    expect(res.body.settings.mail_from.masked).not.toBe('noreply@example.com');
    expect(res.body.settings.mail_from.masked).toMatch(/\.com$/);
  });

  it('空文字を送った項目は変更されない', async () => {
    const { agent } = await createAdminAgent(app);
    const before = await agent.get('/api/admin/settings');
    const beforeMasked = before.body.settings.mail_from.masked;

    const res = await agent.put('/api/admin/settings').set('Origin', TEST_ORIGIN).send({ mail_from: '' });
    expect(res.body.settings.mail_from.masked).toBe(beforeMasked);
  });
});
