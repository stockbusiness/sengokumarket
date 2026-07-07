import type { NextFunction, Request, Response } from 'express';
import { sendError } from '../lib/apiError';

// 仕様書外の拡張: Vercel Cronからの呼び出し専用の認証。
// Vercelは環境変数CRON_SECRETが設定されていると、cron実行時に
// Authorization: Bearer <CRON_SECRET> ヘッダーを自動付与する。
export function requireCronSecret(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return sendError(res, 503, 'CRON_SECRET_NOT_CONFIGURED', 'CRON_SECRETが設定されていません');
  }

  if (req.headers.authorization !== `Bearer ${secret}`) {
    return sendError(res, 401, 'UNAUTHENTICATED', '認証情報が正しくありません');
  }

  next();
}
