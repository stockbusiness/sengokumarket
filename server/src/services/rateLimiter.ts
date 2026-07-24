import { prisma } from '../lib/prisma';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

// 残課題指示書Stage12: express-rate-limitの既定MemoryStoreはVercelの各サーバーレスインスタンス
// ごとに独立しており、複数インスタンス間で回数が共有されない(login_attemptsと同じ問題)。
// 固定ウィンドウ方式でPostgresに永続化することで、インスタンスをまたいでも同じキーなら
// 同一の回数として扱われるようにする。
//
// フェイルオープン方針: レート制限用のDBアクセス自体が失敗した場合、ここで例外を伝播させて
// ログイン・決済等の主要機能そのものを止めてしまう方が実害が大きいため、制限をかけずに
// 通す(fail-open)。エラーはログに残し、DB自体の障害は別途監視で気づける前提とする。
export async function checkRateLimit(key: string, windowMs: number, limit: number): Promise<RateLimitResult> {
  const now = new Date();

  try {
    // upsertのincrementはDB側で単一行に対して原子的に実行されるため、同時リクエスト間での
    // カウント取りこぼしは起きない。ウィンドウが切れている場合のリセットだけは後続の
    // updateで行うため、ウィンドウ境界をまたぐごく一部のリクエストで一時的に多めに
    // カウントされることがあるが、レート制限の性質上許容する(過小に制限して正常利用を
    // 過剰にブロックするより安全な方向の誤差)。
    const record = await prisma.rateLimitBucket.upsert({
      where: { bucketKey: key },
      create: { bucketKey: key, windowStart: now, count: 1 },
      update: { count: { increment: 1 } },
    });

    if (now.getTime() - record.windowStart.getTime() >= windowMs) {
      await prisma.rateLimitBucket.update({
        where: { bucketKey: key },
        data: { windowStart: now, count: 1 },
      });
      return { allowed: true };
    }

    if (record.count > limit) {
      const retryAfterSeconds = Math.ceil((record.windowStart.getTime() + windowMs - now.getTime()) / 1000);
      return { allowed: false, retryAfterSeconds: Math.max(retryAfterSeconds, 1) };
    }

    return { allowed: true };
  } catch (e) {
    console.error('checkRateLimit: レート制限用DBアクセスに失敗しました(fail-open: 制限をかけずに通します)', e);
    return { allowed: true };
  }
}
