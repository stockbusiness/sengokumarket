import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { sendError } from '../lib/apiError';
import { getSetting } from '../services/settings';

// 外部の代理店システムからのサーバー間API呼び出し用認証。
// Cookie/JWTは使わず、管理画面で発行するAPIキーをヘッダーで検証する(仕様書外の拡張)。
// x-api-key / Authorization: Bearer のどちらでも受け付ける(先方仕様書v3.6.38準拠)。
export async function requireAgencyApiKey(req: Request, res: Response, next: NextFunction) {
  const bearerMatch = req.header('authorization')?.match(/^Bearer (.+)$/);
  const provided = req.header('x-api-key') ?? bearerMatch?.[1];
  if (typeof provided !== 'string' || provided.length === 0) {
    return sendError(res, 401, 'API_KEY_REQUIRED', 'APIキーが必要です');
  }

  const configured = await getSetting('agency_api_key');
  if (!configured) {
    return sendError(res, 503, 'API_KEY_NOT_CONFIGURED', 'APIキーが未設定です');
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return sendError(res, 401, 'INVALID_API_KEY', 'APIキーが正しくありません');
  }

  next();
}
