import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../lib/prisma';
import { createAdminAgent, TEST_ORIGIN } from '../../test/adminAgent';

const app = createApp();

describe('管理API: 銀行振込設定(仕様書外の拡張)', () => {
  afterAll(async () => {
    await prisma.setting.deleteMany({ where: { key: { in: ['bank_transfer_enabled', 'bank_transfer_info'] } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'admin-test' } } });
    await prisma.$disconnect();
  });

  it('一般ユーザーは403', async () => {
    const email = `admin-banktransfer-settings-test-user-${Date.now()}@example.com`;
    const agent = request.agent(app);
    await agent.post('/api/auth/register').set('Origin', TEST_ORIGIN).send({ name: '一般', email, password: 'password123' });
    const res = await agent.get('/api/admin/bank-transfer-settings');
    expect(res.status).toBe(403);
  });

  it('未設定はenabled=false, info=""を返す', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.get('/api/admin/bank-transfer-settings');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.info).toBe('');
  });

  it('保存すると平文のままinfoが返る(他の設定と異なりマスクしない)', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent
      .put('/api/admin/bank-transfer-settings')
      .set('Origin', TEST_ORIGIN)
      .send({ enabled: true, info: '銀行名: サンプル銀行\n口座番号: 1234567' });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.info).toBe('銀行名: サンプル銀行\n口座番号: 1234567');

    const after = await agent.get('/api/admin/bank-transfer-settings');
    expect(after.body.info).toBe('銀行名: サンプル銀行\n口座番号: 1234567');
  });

  it('enabledが真偽値でない場合は400を返す', async () => {
    const { agent } = await createAdminAgent(app);
    const res = await agent.put('/api/admin/bank-transfer-settings').set('Origin', TEST_ORIGIN).send({ enabled: 'yes', info: 'x' });
    expect(res.status).toBe(400);
  });
});
