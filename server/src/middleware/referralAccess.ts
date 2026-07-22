import type { NextFunction, Request, Response } from 'express';
import { sendError } from '../lib/apiError';
import { AUTH_COOKIE_NAME } from '../lib/authCookie';
import { verifyAuthToken } from '../services/jwt';
import { prisma } from '../lib/prisma';

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
//
// 仕様書外の拡張(2026-07-22千ノ国全体連携パッケージ SYSTEM_ANALYSIS 15.3の指摘対応):
// 以前は`ref`クエリが空文字列でなければ内容を検証せず通過させていたため、`?ref=適当な文字列`
// だけで非公開の商品カタログを閲覧できてしまっていた。実在するreferral_links.code(有効な
// もの限定)かどうかをDBで確認したうえで通過させるようにする。
async function hasReferralQueryParam(req: Request): Promise<boolean> {
  const ref = req.query?.ref;
  if (typeof ref !== 'string' || ref.trim().length === 0) return false;

  const link = await prisma.referralLink.findFirst({ where: { code: ref.trim(), status: 'active' } });
  return link !== null;
}

// このカートは一般公開せず、代理店が配布する紹介URL経由でのみ利用する運用のため、
// 紹介URLを一度も踏んでいない・ログインもしていないブラウザには商品情報を公開しない
// (仕様書外の拡張)。
export async function requireReferralOrAuth(req: Request, res: Response, next: NextFunction) {
  if (hasValidReferralCookie(req) || hasValidAuthCookie(req) || (await hasReferralQueryParam(req))) {
    return next();
  }
  sendError(res, 403, 'REFERRAL_REQUIRED', '本サービスは代理店からご案内されたURLからのみご利用いただけます');
}
