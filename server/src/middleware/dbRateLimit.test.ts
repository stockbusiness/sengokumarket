import { afterAll, afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { prisma } from '../lib/prisma';
import { dbRateLimit, type DbRateLimitOptions } from './dbRateLimit';

function buildApp(opts: DbRateLimitOptions) {
  const app = express();
  // 本番のapp.tsと同じくtrust proxyを1(直前のプロキシ1段のみ信頼)に設定する。
  app.set('trust proxy', 1);
  app.get('/test', dbRateLimit(opts), (_req, res) => res.json({ ok: true }));
  return app;
}

// 本番安定化指示書Stage3・6.8受入条件の直接検証:
// 「identifierを変えるだけでIP制限を回避できない」「同一identifierを複数IPから攻撃しても
// identifier制限が効く」の両方、およびincludeCombinedBucket/includeIpBucket/trust proxyの挙動。
describe('dbRateLimit middleware(本番安定化指示書Stage3・6.8受入条件)', () => {
  afterEach(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { bucketKey: { startsWith: 'dbratelimit-test-' } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('identifierを変えるだけではIP単独bucketの上限を回避できない', async () => {
    const scope = `dbratelimit-test-ip-${Date.now()}`;
    const app = buildApp({
      windowMs: 60_000,
      limit: 100,
      ipLimit: 3,
      scope,
      identify: (req) => (typeof req.query.id === 'string' ? req.query.id : undefined),
    });

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/test').query({ id: `identifier-${i}` });
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).get('/test').query({ id: 'identifier-new' });
    expect(blocked.status).toBe(429);
  });

  it('同一identifierを複数IPから攻撃してもidentifier単独bucketが効く', async () => {
    const scope = `dbratelimit-test-id-${Date.now()}`;
    const app = buildApp({
      windowMs: 60_000,
      limit: 3,
      ipLimit: 100,
      scope,
      identify: () => 'shared-identifier',
    });

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/test').set('X-Forwarded-For', `10.0.0.${i}`);
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).get('/test').set('X-Forwarded-For', '10.0.0.99');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('includeCombinedBucket:falseの場合、IP+identifier複合bucketは作られない(referral-resolveの方針)', async () => {
    const scope = `dbratelimit-test-combined-${Date.now()}`;
    const app = buildApp({
      windowMs: 60_000,
      limit: 100,
      ipLimit: 100,
      scope,
      identify: () => 'some-id',
      includeCombinedBucket: false,
    });

    await request(app).get('/test');

    const combined = await prisma.rateLimitBucket.findFirst({ where: { bucketKey: { startsWith: `${scope}:ip-id:` } } });
    expect(combined).toBeNull();
  });

  it('includeIpBucket:falseの場合、IP単独bucketは作られない(外部連携APIキー単位の2段目制限の方針)', async () => {
    const scope = `dbratelimit-test-noip-${Date.now()}`;
    const app = buildApp({
      windowMs: 60_000,
      limit: 100,
      scope,
      identify: () => 'api-key-hash',
      includeIpBucket: false,
    });

    await request(app).get('/test');

    const ipBucket = await prisma.rateLimitBucket.findFirst({ where: { bucketKey: { startsWith: `${scope}:ip:` } } });
    expect(ipBucket).toBeNull();
    const idBucket = await prisma.rateLimitBucket.findUnique({ where: { bucketKey: `${scope}:id:api-key-hash` } });
    expect(idBucket).not.toBeNull();
  });

  it('trust proxy設定により、X-Forwarded-Forの値がIP単独bucketのキーに使われる', async () => {
    const scope = `dbratelimit-test-trustproxy-${Date.now()}`;
    const app = buildApp({ windowMs: 60_000, limit: 1, scope });

    const res = await request(app).get('/test').set('X-Forwarded-For', '203.0.113.5');
    expect(res.status).toBe(200);

    const bucket = await prisma.rateLimitBucket.findUnique({ where: { bucketKey: `${scope}:ip:203.0.113.5` } });
    expect(bucket).not.toBeNull();
  });
});
