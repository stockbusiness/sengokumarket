import type { NextFunction, Request, Response } from 'express';
import { checkRateLimit } from '../services/rateLimiter';
import { sendError, sendIntegrationError } from '../lib/apiError';

export interface DbRateLimitOptions {
  windowMs: number;
  limit: number;
  // レート制限キーの名前空間(例: "login", "coupon-validate")。IPやidentifyの結果と
  // 組み合わせてbucket_keyを作る。
  scope: string;
  // IPに加えて対象識別子(メールアドレス・クーポンコード等)でも制限したい場合に指定する。
  // undefinedを返した場合はIPのみで制限する。
  identify?: (req: Request) => string | undefined;
  // 外部代理店連携API(/api/integrations配下)は{ok:false,...}形式のエラーを返す必要があるため。
  errorFormat?: 'app' | 'integration';
}

// 残課題指示書Stage12: register/login/password-reset/checkout/coupon/referral/agency-sso/
// 外部連携APIに、Vercelの複数インスタンス間で共有される分散レートリミットを適用する。
export function dbRateLimit(options: DbRateLimitOptions) {
  const sendLimitError = options.errorFormat === 'integration' ? sendIntegrationError : sendError;

  return async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const ip = req.ip ?? 'unknown';
    const identifier = options.identify?.(req);
    const key = identifier ? `${options.scope}:ip:${ip}:id:${identifier}` : `${options.scope}:ip:${ip}`;

    const result = await checkRateLimit(key, options.windowMs, options.limit);
    if (!result.allowed) {
      const retryAfterSeconds = result.retryAfterSeconds ?? Math.ceil(options.windowMs / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return sendLimitError(res, 429, 'RATE_LIMIT_EXCEEDED', 'リクエストが集中しています。しばらくしてから再度お試しください');
    }
    next();
  };
}
