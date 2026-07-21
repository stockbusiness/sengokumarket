import type { NextFunction, Request, Response } from 'express';
import { sendError } from '../lib/apiError';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Cookie認証はSameSite=Strictに加え、状態変更系APIでOrigin検証を行う(仕様書v1.5 16章)。
export function requireSameOrigin(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();

  const appUrl = process.env.APP_URL;
  // 仕様書外の拡張(千ノ国全体連携分析2026-07-21 I-1章の指摘): APP_URL未設定はCSRF対策自体を
  // 無効化してしまうfail-openだったため、fail-closed(拒否)に変更する。設定ミスや環境変数の
  // 読み込み漏れが発生した際に、この検証だけが静かに素通りする事故を防ぐ。
  if (!appUrl) {
    console.error('APP_URL is not set; rejecting state-changing request for CSRF safety');
    return sendError(res, 403, 'CSRF_ORIGIN_MISMATCH', 'リクエスト元を確認できませんでした');
  }

  const origin = req.headers.origin;
  if (origin === appUrl) return next();

  const referer = req.headers.referer;
  if (referer && referer.startsWith(appUrl)) return next();

  return sendError(res, 403, 'CSRF_ORIGIN_MISMATCH', 'リクエスト元を確認できませんでした');
}
