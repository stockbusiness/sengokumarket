import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { appConfig } from '../shared/config/appConfig';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

// 本番安定化指示書Stage3(6.3「identifier保護」): メールアドレス・クーポンコード・紹介コード等の
// identifierをbucket_keyへ平文で保存しない。HMAC-SHA256でハッシュ化してから使う
// (正規化してからハッシュ化することで、大文字小文字・前後空白違いを同一identifierとして扱う)。
export function hashRateLimitIdentifier(value: string): string {
  const secret = appConfig.rateLimitHashSecret;
  if (!secret) throw new Error('RATE_LIMIT_HASH_SECRET is not set');
  return crypto.createHmac('sha256', secret).update(value.trim().toLowerCase()).digest('hex');
}

// 残課題指示書Stage12: express-rate-limitの既定MemoryStoreはVercelの各サーバーレスインスタンス
// ごとに独立しており、複数インスタンス間で回数が共有されない(login_attemptsと同じ問題)。
// 固定ウィンドウ方式でPostgresに永続化することで、インスタンスをまたいでも同じキーなら
// 同一の回数として扱われるようにする。
//
// フェイルオープン方針: レート制限用のDBアクセス自体が失敗した場合、ここで例外を伝播させて
// ログイン・決済等の主要機能そのものを止めてしまう方が実害が大きいため、制限をかけずに
// 通す(fail-open)。エラーはログに残し、DB自体の障害は別途監視で気づける前提とする。
//
// 本番安定化指示書Stage3(6.4「原子的更新」): 旧実装はupsert→期限判定→updateの2段階処理で
// あり、ウィンドウ境界をまたぐ同時リクエスト間でわずかにカウントの取りこぼしが起こりうる
// (upsertでincrementした直後、別リクエストが先にwindow_startをリセットしてしまう競合)。
// PostgreSQLのINSERT ... ON CONFLICT ... RETURNINGを1文で使い、判定と更新を単一のSQL文の中で
// 原子的に完結させる。
export async function checkRateLimit(key: string, windowMs: number, limit: number): Promise<RateLimitResult> {
  try {
    const rows = await prisma.$queryRaw<{ count: number; windowStart: Date }[]>`
      INSERT INTO rate_limit_buckets (bucket_key, window_start, count, updated_at)
      VALUES (${key}, now(), 1, now())
      ON CONFLICT (bucket_key) DO UPDATE SET
        count = CASE
          WHEN rate_limit_buckets.window_start <= now() - (${windowMs} * interval '1 millisecond')
            THEN 1
          ELSE rate_limit_buckets.count + 1
        END,
        window_start = CASE
          WHEN rate_limit_buckets.window_start <= now() - (${windowMs} * interval '1 millisecond')
            THEN now()
          ELSE rate_limit_buckets.window_start
        END,
        updated_at = now()
      RETURNING count, window_start AS "windowStart"
    `;
    const record = rows[0];

    if (record.count > limit) {
      const retryAfterSeconds = Math.ceil((record.windowStart.getTime() + windowMs - Date.now()) / 1000);
      return { allowed: false, retryAfterSeconds: Math.max(retryAfterSeconds, 1) };
    }

    return { allowed: true };
  } catch (e) {
    console.error('checkRateLimit: レート制限用DBアクセスに失敗しました(fail-open: 制限をかけずに通します)', e);
    return { allowed: true };
  }
}

const STALE_BUCKET_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// 本番安定化指示書Stage3(6.7「古いbucketの掃除」): windowを跨いで長期間更新されていない
// bucketはrate_limit_buckets.updated_atのindex(20260725010000マイグレーション)を使って
// 定期的に物理削除する。放置すると行数が際限なく増え続けるため。
export async function cleanupStaleRateLimitBuckets(): Promise<{ deletedCount: number }> {
  const result = await prisma.rateLimitBucket.deleteMany({
    where: { updatedAt: { lt: new Date(Date.now() - STALE_BUCKET_RETENTION_MS) } },
  });
  return { deletedCount: result.count };
}
