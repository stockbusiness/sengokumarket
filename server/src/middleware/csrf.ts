import type { NextFunction, Request, Response } from 'express';
import { sendError } from '../lib/apiError';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Cookie認証はSameSite=Strictに加え、状態変更系APIでOrigin検証を行う(仕様書v1.5 16章)。
export function requireSameOrigin(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();

  const appUrl = process.env.APP_URL;
  if (!appUrl) return next();

  const origin = req.headers.origin;
  if (origin === appUrl) return next();

  const referer = req.headers.referer;
  if (referer && referer.startsWith(appUrl)) return next();

  return sendError(res, 403, 'CSRF_ORIGIN_MISMATCH', 'リクエスト元を確認できませんでした');
}
