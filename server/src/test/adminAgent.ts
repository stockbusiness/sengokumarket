import type { Express } from 'express';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';

export const TEST_ORIGIN = 'http://localhost:5173';

export async function createAdminAgent(app: Express) {
  const email = `admin-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const user = await prisma.user.create({
    data: { name: '管理者テスト', email, passwordHash: await bcrypt.hash('adminpassword1', 10), role: 'admin' },
  });

  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: 'adminpassword1' });

  return { agent, userId: user.id, email };
}
