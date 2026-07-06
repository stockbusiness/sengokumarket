import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { prisma } from './lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from './test/adminAgent';

const app = createApp();

// Express 4はasyncハンドラ内で拒否されたPromiseを自動でエラーミドルウェアに回さず、
// 何も応答しないままリクエストが無限にハングする(例: DBスキーマ不整合等の予期しない例外)。
// express-async-errorsの導入により、こうした例外も一律SERVER_ERRORとして即座に返ることを確認する。
describe('未捕捉の非同期例外がハングせずSERVER_ERRORとして返る', () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('DBレベルのエラー(不正なUUID形式)が即座に500として返る', async () => {
    const { agent } = await createAdminAgent(app);

    const res = await agent
      .put('/api/admin/orders/not-a-valid-uuid-format')
      .set('Origin', TEST_ORIGIN)
      .send({ orderStatus: 'paid' });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('SERVER_ERROR');
  }, 8000);
});
