import type { NextFunction, Request, Response } from 'express';
import { checkRateLimit } from '../services/rateLimiter';
import { sendError, sendIntegrationError } from '../lib/apiError';

export interface DbRateLimitOptions {
  windowMs: number;
  // identifier単独・IP+identifier複合bucketの上限。identifyを指定しない場合はIP単独bucketの
  // 上限としても使われる。
  limit: number;
  // IP単独bucketの上限(既定はlimitと同じ値)。IPは複数の正当な利用者が共有しうる
  // (社内ネットワーク・共有Wi-Fi等)ため、identifier単独より緩めの値を指定できるようにする
  // (本番安定化指示書6.8「正常利用を過剰にブロックしない」)。
  ipLimit?: number;
  // レート制限キーの名前空間(例: "login", "coupon-validate")。IPやidentifyの結果と
  // 組み合わせてbucket_keyを作る。
  scope: string;
  // 対象識別子(メールアドレス・クーポンコード・紹介コード等、既にhashRateLimitIdentifierで
  // ハッシュ化された値)。指定すると、IP単独・identifier単独・IP+identifier複合の
  // 3種類のbucketを1リクエストにつき独立して検査する(本番安定化指示書Stage3・6.2
  // 「identifierを変えるだけでIP制限を回避できない・同一identifierを複数IPから攻撃しても
  // identifier制限が効く」の両方を満たすため)。undefinedを返した場合はIPのみで判定する。
  identify?: (req: Request) => string | undefined;
  // referral-resolveのようにIP+identifier複合bucketが不要な場合はfalseにする(6.2の例に
  // 忠実に、referralはip・codeの2種類のみとする)。identifyを指定した場合の既定値はtrue。
  includeCombinedBucket?: boolean;
  // IP単独bucketが不要な場合(例: 外部連携APIキー単位の2段目の制限のように、IP判定は
  // 別のdbRateLimitインスタンスで既に行っており、ここでは識別子単独の判定だけを行いたい場合)
  // にfalseにする。既定値はtrue。identifyが指定されていない場合は無視される
  // (IP単独bucketがこの制限の唯一の判定軸になるため)。
  includeIpBucket?: boolean;
  // 外部代理店連携API(/api/integrations配下)は{ok:false,...}形式のエラーを返す必要があるため。
  errorFormat?: 'app' | 'integration';
}

// 残課題指示書Stage12/本番安定化指示書Stage3: register/login/password-reset/checkout/coupon/
// referral/agency-sso/外部連携APIに、Vercelの複数インスタンス間で共有される分散レートリミットを
// 適用する。
export function dbRateLimit(options: DbRateLimitOptions) {
  const sendLimitError = options.errorFormat === 'integration' ? sendIntegrationError : sendError;
  const includeCombined = options.includeCombinedBucket ?? true;
  const includeIp = options.includeIpBucket ?? true;
  const ipLimit = options.ipLimit ?? options.limit;

  return async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const ip = req.ip ?? 'unknown';
    const identifier = options.identify?.(req);

    const keys: { key: string; limit: number }[] = [];
    if (includeIp || !identifier) keys.push({ key: `${options.scope}:ip:${ip}`, limit: ipLimit });
    if (identifier) {
      keys.push({ key: `${options.scope}:id:${identifier}`, limit: options.limit });
      if (includeCombined) keys.push({ key: `${options.scope}:ip-id:${ip}:${identifier}`, limit: options.limit });
    }

    // どのbucketが後でブロック対象になっても、他のbucketの実際の試行回数を正しく反映させる
    // 必要があるため(例: 同一identifierを複数IPから攻撃するケースでもidentifier単独bucketの
    // カウントは毎回増える必要がある)、先にブロックが確定しても残りのbucketのチェックを
    // 省略しない。
    let retryAfterSeconds: number | undefined;
    for (const { key, limit } of keys) {
      const result = await checkRateLimit(key, options.windowMs, limit);
      if (!result.allowed) {
        retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, result.retryAfterSeconds ?? Math.ceil(options.windowMs / 1000));
      }
    }

    if (retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return sendLimitError(res, 429, 'RATE_LIMIT_EXCEEDED', 'リクエストが集中しています。しばらくしてから再度お試しください');
    }
    next();
  };
}
