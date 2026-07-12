import type { NextFunction, Request, Response } from 'express';
import { sendError } from '../lib/apiError';
import { AUTH_COOKIE_NAME } from '../lib/authCookie';
import { verifyAuthToken } from '../services/jwt';

const REFERRAL_COOKIE_NAME = 'sengoku_referral';

function hasValidReferralCookie(req: Request): boolean {
  const raw = req.cookies?.[REFERRAL_COOKIE_NAME];
  if (typeof raw !== 'string') return false;
  try {
    const parsed = JSON.parse(raw) as { referral_code?: string; expires_at?: string };
    if (!parsed.referral_code) return false;
    if (parsed.expires_at && new Date(parsed.expires_at).getTime() < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

function hasValidAuthCookie(req: Request): boolean {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  return typeof token === 'string' && verifyAuthToken(token) !== null;
}

// クライアント側でCookie保存用のuseEffect(App.tsx)がまだ発火していない初回リクエストでも
// 通過できるよう、Cookieと同程度の信頼レベルとしてクエリパラメータのrefも許可する
// (Reactは子コンポーネントのエフェクトを親より先に実行するため、商品ページ等の初回データ
// 取得がCookie書き込みより先に飛ぶことがある。仕様書外の拡張)。
function hasReferralQueryParam(req: Request): boolean {
  const ref = req.query?.ref;
  return typeof ref === 'string' && ref.trim().length > 0;
}

// このカートは一般公開せず、代理店が配布する紹介URL経由でのみ利用する運用のため、
// 紹介URLを一度も踏んでいない・ログインもしていないブラウザには商品情報を公開しない
// (仕様書外の拡張)。
export function requireReferralOrAuth(req: Request, res: Response, next: NextFunction) {
  if (hasValidReferralCookie(req) || hasValidAuthCookie(req) || hasReferralQueryParam(req)) {
    return next();
  }
  sendError(res, 403, 'REFERRAL_REQUIRED', '本サービスは代理店からご案内されたURLからのみご利用いただけます');
}
