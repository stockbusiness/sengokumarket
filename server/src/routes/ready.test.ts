import { describe, expect, it, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();

// 本番安定化指示書Stage0: Vercelデプロイ成功と本番DB migration成功を混同しないための
// /api/readyの動作確認。
describe('GET /api/ready', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('DB接続・必須migration・環境変数が正常な場合はstatus:readyかつ200を返す', async () => {
    const res = await request(app).get('/api/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.database).toBe('ok');
    expect(res.body.migrations).toBe('ok');
    expect(typeof res.body.integrationEnabled).toBe('boolean');
  });

  it('SENNOKUNI_INTEGRATION_ENABLEDがfalse(既定)の場合、integrationEnabled:falseを返す', async () => {
    const original = process.env.SENNOKUNI_INTEGRATION_ENABLED;
    delete process.env.SENNOKUNI_INTEGRATION_ENABLED;
    try {
      const res = await request(app).get('/api/ready');
      expect(res.body.integrationEnabled).toBe(false);
    } finally {
      if (original !== undefined) process.env.SENNOKUNI_INTEGRATION_ENABLED = original;
    }
  });

  it('レスポンスに秘密情報(接続文字列・鍵の値そのもの)を含まない', async () => {
    const res = await request(app).get('/api/ready');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(process.env.DATABASE_URL ?? '__unset__');
    expect(body).not.toContain(process.env.JWT_SECRET ?? '__unset__');
    expect(body).not.toContain(process.env.SETTINGS_ENCRYPTION_KEY ?? '__unset__');
  });
});
