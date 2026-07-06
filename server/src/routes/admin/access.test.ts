import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

describe('管理API 認可', () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-access-test' } } });
    await prisma.$disconnect();
  });

  it('未認証は401', async () => {
    const res = await request(app).get('/api/admin/dashboard');
    expect(res.status).toBe(401);
  });

  it('一般ユーザーは403', async () => {
    const email = `admin-access-test-user-${Date.now()}@example.com`;
    const agent = request.agent(app);
    await agent.post('/api/auth/register').set('Origin', TEST_ORIGIN).send({ name: '一般', email, password: 'password123' });

    const res = await agent.get('/api/admin/dashboard');
    expect(res.status).toBe(403);
  });

  it('管理者は200', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/dashboard');
    expect(res.status).toBe(200);
  });
});
