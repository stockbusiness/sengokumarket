import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { checkRateLimit } from './rateLimiter';

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
    const spy = vi.spyOn(prisma.rateLimitBucket, 'upsert').mockRejectedValue(new Error('simulated DB failure'));
    try {
      const result = await checkRateLimit(`ratelimiter-svc-test-failopen-${Date.now()}`, 60_000, 1);
      expect(result.allowed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
