import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { sendIntegrationError } from '../lib/apiError';
import { getSetting } from '../services/settings';

// 外部の代理店システムからのサーバー間API呼び出し用認証。
// Cookie/JWTは使わず、管理画面で発行するAPIキーをヘッダーで検証する(仕様書外の拡張)。
// x-api-key / Authorization: Bearer のどちらでも受け付ける(外部開発者向け連携ガイドv3.6.78-draft 6.1準拠)。
// エラーレスポンスは同ガイド13章が指定する{ok:false, error:{code,message}}形式で返す。
export async function requireAgencyApiKey(req: Request, res: Response, next: NextFunction) {
  const bearerMatch = req.header('authorization')?.match(/^Bearer (.+)$/);
  const provided = req.header('x-api-key') ?? bearerMatch?.[1];
  if (typeof provided !== 'string' || provided.length === 0) {
    return sendIntegrationError(res, 401, 'API_KEY_REQUIRED', 'API key is required.');
  }

  const configured = await getSetting('agency_api_key');
  if (!configured) {
    return sendIntegrationError(res, 503, 'AGENCY_API_KEY_NOT_CONFIGURED', 'API key is not configured.');
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return sendIntegrationError(res, 401, 'INVALID_API_KEY', 'API key is invalid.');
  }

  next();
}
