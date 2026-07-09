import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/httpError';
import { getSetting } from './settings';

// 仕様書外の拡張(先方仕様書v3.6.45準拠): 代理店システム(IdP)発行のSSOトークンを検証し、
// 対応する代理店ポータルアカウントを特定する。エラーコードは先方仕様書のログイン画面
// リダイレクトパラメータ(/login?error=...)の値とそのまま揃えている。
const SSO_AUDIENCE = 'sengoku-rr';
const CLOCK_TOLERANCE_SECONDS = 60;

let cachedJwks: { url: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

function getJwks(jwksUrl: string) {
  if (!cachedJwks || cachedJwks.url !== jwksUrl) {
    cachedJwks = { url: jwksUrl, jwks: createRemoteJWKSet(new URL(jwksUrl)) };
  }
  return cachedJwks.jwks;
}

export interface AgencySsoLoginResult {
  userId: string;
  returnTo: string | null;
}

function isSafeInternalPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
}

export async function verifyAndConsumeAgencySsoToken(token: string): Promise<AgencySsoLoginResult> {
  const rawBaseUrl = await getSetting('external_agency_system_base_url');
  if (!rawBaseUrl) {
    throw new HttpError(503, 'sso_not_configured', 'SSO連携設定が未登録です');
  }
  const baseUrl = rawBaseUrl.replace(/\/$/, '');

  const jwks = getJwks(`${baseUrl}/api/sso/jwks.php`);

  let payload;
  try {
    const result = await jwtVerify(token, jwks, {
      issuer: baseUrl,
      audience: SSO_AUDIENCE,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    payload = result.payload;
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) {
      throw new HttpError(401, 'sso_expired', 'SSOトークンの有効期限が切れています');
    }
    throw new HttpError(401, 'sso_invalid', 'SSOトークンの検証に失敗しました');
  }

  const { sub, jti, exp } = payload;
  if (typeof sub !== 'string' || typeof jti !== 'string' || typeof exp !== 'number') {
    throw new HttpError(401, 'sso_invalid', 'SSOトークンの形式が不正です');
  }

  // jtiの一度きり利用をDBのユニーク制約で保証する(先方仕様書8章)。チェック後にINSERTする
  // 二段階ではなく、INSERT自体をリプレイ判定に使うことで競合状態を避ける。
  try {
    await prisma.ssoUsedJti.create({
      data: { jti, sub, aud: SSO_AUDIENCE, expiresAt: new Date(exp * 1000) },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new HttpError(401, 'sso_replayed', 'このSSOトークンは既に使用されています');
    }
    throw e;
  }

  const agency = await prisma.agency.findUnique({ where: { externalId: sub } });
  if (!agency) {
    throw new HttpError(401, 'agency_not_linked', '代理店ポータルとの連携が見つかりません');
  }
  if (agency.status !== 'active') {
    throw new HttpError(403, 'agency_inactive', 'この代理店は停止中です');
  }

  const user = await prisma.user.findFirst({ where: { agencyId: agency.id, role: 'agency' } });
  if (!user) {
    throw new HttpError(401, 'agency_not_linked', '代理店ポータルのログインアカウントが未発行です');
  }

  return { userId: user.id, returnTo: isSafeInternalPath(payload.return_to) ? payload.return_to : null };
}
