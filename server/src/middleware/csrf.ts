import type { NextFunction, Request, Response } from 'express';
import { sendError } from '../lib/apiError';
import { appConfig } from '../shared/config/appConfig';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Cookie認証はSameSite=Strictに加え、状態変更系APIでOrigin検証を行う(仕様書v1.5 16章)。

// 仕様書外の拡張(2026-07-22指示書Stage4): Origin/Referer/APP_URLをURLとしてparseし、
// schema+host+portからなる`.origin`のみを厳密比較する。単純な文字列前方一致
// (`referer.startsWith(appUrl)`)は、APP_URL=https://example.comに対して
// https://example.com.evil.example/pathのような別オリジンを誤って通してしまう
// バイパス経路があったため廃止する。不正なURL文字列はnullを返し、必ず拒否側に倒す。
function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function requireSameOrigin(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();

  const appUrl = appConfig.appUrl;
  const appOrigin = appUrl ? parseOrigin(appUrl) : null;
  // 仕様書外の拡張(千ノ国全体連携分析2026-07-21 I-1章の指摘): APP_URL未設定・不正値はCSRF対策
  // 自体を無効化してしまうfail-openだったため、fail-closed(拒否)にする。設定ミスや環境変数の
  // 読み込み漏れが発生した際に、この検証だけが静かに素通りする事故を防ぐ。
  if (!appOrigin) {
    console.error('APP_URL is not set or invalid; rejecting state-changing request for CSRF safety');
    return sendError(res, 403, 'CSRF_ORIGIN_MISMATCH', 'リクエスト元を確認できませんでした');
  }

  const origin = req.headers.origin;
  if (typeof origin === 'string' && parseOrigin(origin) === appOrigin) return next();

  const referer = req.headers.referer;
  if (typeof referer === 'string' && parseOrigin(referer) === appOrigin) return next();

  return sendError(res, 403, 'CSRF_ORIGIN_MISMATCH', 'リクエスト元を確認できませんでした');
}
