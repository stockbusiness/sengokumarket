import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { checkRateLimit, cleanupStaleRateLimitBuckets } from './rateLimiter';

describe('rateLimiter service(残課題指示書Stage12: 分散レートリミット)', () => {
  afterAll(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { bucketKey: { contains: 'ratelimiter-svc-test' } } });
    await prisma.$disconnect();
  });

  it('上限未満のリクエストは全て許可される', async () => {
    const key = `ratelimiter-svc-test-under-${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      const result = await checkRateLimit(key, 60_000, 3);
      expect(result.allowed).toBe(true);
    }
  });

  it('上限を超えるとブロックされ、retryAfterSecondsが返る', async () => {
    const key = `ratelimiter-svc-test-over-${Date.now()}`;
    for (let i = 0; i < 3; i++) {
      const result = await checkRateLimit(key, 60_000, 3);
      expect(result.allowed).toBe(true);
    }

    const blocked = await checkRateLimit(key, 60_000, 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('複数インスタンスを模した並行呼び出しでも、同じキーなら合算してカウントされる(共有ストアであることの確認)', async () => {
    const key = `ratelimiter-svc-test-shared-${Date.now()}`;
    // 2つの「別インスタンス」からの呼び出しを模して、それぞれ独立にcheckRateLimitを呼ぶ。
    const [a, b] = await Promise.all([checkRateLimit(key, 60_000, 1), checkRateLimit(key, 60_000, 1)]);
    const allowedCount = [a, b].filter((r) => r.allowed).length;
    // インメモリストアでは各インスタンスが独立に「1件目だから許可」と判定してしまうが、
    // 共有DBストアであれば合計2件のうち少なくとも1件はブロックされる。
    expect(allowedCount).toBeLessThan(2);
  });

  it('ウィンドウが経過すると再びカウントされ直す', async () => {
    const key = `ratelimiter-svc-test-window-${Date.now()}`;
    await checkRateLimit(key, 60_000, 1);
    const blocked = await checkRateLimit(key, 60_000, 1);
    expect(blocked.allowed).toBe(false);

    // 実時間の経過を待つ代わりに、windowStartを直接過去へずらして期限切れを再現する
    // (loginAttempts.test.tsと同じ慣習)。
    await prisma.rateLimitBucket.update({ where: { bucketKey: key }, data: { windowStart: new Date(Date.now() - 61_000) } });

    const afterWindow = await checkRateLimit(key, 60_000, 1);
    expect(afterWindow.allowed).toBe(true);
  });

  it('DBアクセスが失敗してもフェイルオープンでリクエストを許可する', async () => {
    const spy = vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('simulated DB failure'));
    try {
      const result = await checkRateLimit(`ratelimiter-svc-test-failopen-${Date.now()}`, 60_000, 1);
      expect(result.allowed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('hashRateLimitIdentifier(本番安定化指示書Stage3: identifier保護)', () => {
  it('同じ値は正規化(trim・小文字化)後に同一ハッシュになる', async () => {
    const { hashRateLimitIdentifier } = await import('./rateLimiter');
    const a = hashRateLimitIdentifier('  User@Example.com  ');
    const b = hashRateLimitIdentifier('user@example.com');
    expect(a).toBe(b);
  });

  it('値が違えばハッシュも異なる', async () => {
    const { hashRateLimitIdentifier } = await import('./rateLimiter');
    expect(hashRateLimitIdentifier('a@example.com')).not.toBe(hashRateLimitIdentifier('b@example.com'));
  });

  it('平文の値そのものはハッシュ結果に含まれない(bucket_keyへ平文保存しないことの確認)', async () => {
    const { hashRateLimitIdentifier } = await import('./rateLimiter');
    const hash = hashRateLimitIdentifier('secret-coupon-code');
    expect(hash).not.toContain('secret-coupon-code');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('cleanupStaleRateLimitBuckets(本番安定化指示書Stage3・6.7: 古いbucketの掃除)', () => {
  afterAll(async () => {
    await prisma.rateLimitBucket.deleteMany({ where: { bucketKey: { contains: 'ratelimiter-cleanup-test' } } });
    await prisma.$disconnect();
  });

  it('7日以上更新のないbucketは削除され、最近更新されたbucketは残る', async () => {
    const staleKey = `ratelimiter-cleanup-test-stale-${Date.now()}`;
    const freshKey = `ratelimiter-cleanup-test-fresh-${Date.now()}`;
    await checkRateLimit(staleKey, 60_000, 10);
    await checkRateLimit(freshKey, 60_000, 10);

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await prisma.rateLimitBucket.update({ where: { bucketKey: staleKey }, data: { updatedAt: eightDaysAgo } });

    const result = await cleanupStaleRateLimitBuckets();
    expect(result.deletedCount).toBeGreaterThanOrEqual(1);

    const stale = await prisma.rateLimitBucket.findUnique({ where: { bucketKey: staleKey } });
    expect(stale).toBeNull();
    const fresh = await prisma.rateLimitBucket.findUnique({ where: { bucketKey: freshKey } });
    expect(fresh).not.toBeNull();
  });
});
