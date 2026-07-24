import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../lib/prisma';

const app = createApp();

describe('GET /referrals/resolve(残課題指示書Stage12: 分散レートリミット)', () => {
  afterAll(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { bucketKey: { contains: 'referral-resolve' } } });
    await prisma.$disconnect();
  });

  it('存在しないコードはfound:falseを返す', async () => {
    const res = await request(app).get('/api/referrals/resolve').query({ code: `referrals-test-nonexistent-${Date.now()}` });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
  });

  it('同一コードへの試行が上限を超えると429・Retry-Afterヘッダーを返す', async () => {
    const code = `referrals-test-ratelimit-${Date.now()}`;

    for (let i = 0; i < 10; i++) {
      const res = await request(app).get('/api/referrals/resolve').query({ code });
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).get('/api/referrals/resolve').query({ code });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('別のコードへの試行は独立してカウントされ、他コードの上限超過の影響を受けない', async () => {
    const codeA = `referrals-test-independent-a-${Date.now()}`;
    const codeB = `referrals-test-independent-b-${Date.now()}`;

    for (let i = 0; i < 11; i++) {
      await request(app).get('/api/referrals/resolve').query({ code: codeA });
    }

    const res = await request(app).get('/api/referrals/resolve').query({ code: codeB });
    expect(res.status).toBe(200);
  });
});
