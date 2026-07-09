import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Prisma, type Agency } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/httpError';
import { getSetting } from './settings';
import { generateAgencyCode } from './referralCodeGenerator';

// 仕様書外の拡張(先方仕様書v3.6.45準拠): 代理店システム(IdP)発行のSSOトークンを検証し、
// 対応する代理店ポータルアカウントを特定する。エラーコードは先方仕様書のログイン画面
// リダイレクトパラメータ(/login?error=...)の値とそのまま揃えている。
//
// joseやjwks-rsa(内部でjoseに依存)はESM専用パッケージを含み、このサーバー(CommonJS
// ビルド)からのrequireに失敗する恐れがあるため使わない。JWKS取得はプロジェクトの他の
// 外部連携と同じ素のfetch、鍵の変換はNode組み込みのcrypto.createPublicKeyのみで行う。
const SSO_AUDIENCE = 'sengoku-rr';
const CLOCK_TOLERANCE_SECONDS = 60;
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedJwks {
  url: string;
  fetchedAt: number;
  keys: Map<string, crypto.KeyObject>;
}

let cachedJwks: CachedJwks | null = null;

async function fetchJwks(jwksUrl: string): Promise<Map<string, crypto.KeyObject>> {
  const res = await fetch(jwksUrl);
  if (!res.ok) {
    throw new HttpError(401, 'sso_invalid', `JWKSの取得に失敗しました(HTTP ${res.status})`);
  }
  const body = (await res.json()) as { keys?: Array<Record<string, unknown>> };
  const keys = new Map<string, crypto.KeyObject>();
  for (const jwk of body.keys ?? []) {
    const kid = jwk.kid;
    if (typeof kid !== 'string') continue;
    try {
      keys.set(kid, crypto.createPublicKey({ key: jwk as crypto.JsonWebKeyInput['key'], format: 'jwk' }));
    } catch {
      // このプロジェクトが対応しない鍵形式(RSA以外等)は無視する。
    }
  }
  return keys;
}

async function getSigningKey(jwksUrl: string, kid: string): Promise<crypto.KeyObject> {
  const now = Date.now();
  const needsRefresh =
    !cachedJwks || cachedJwks.url !== jwksUrl || now - cachedJwks.fetchedAt > JWKS_CACHE_TTL_MS || !cachedJwks.keys.has(kid);

  if (needsRefresh) {
    const keys = await fetchJwks(jwksUrl);
    cachedJwks = { url: jwksUrl, fetchedAt: now, keys };
  }

  const key = cachedJwks!.keys.get(kid);
  if (!key) {
    throw new HttpError(401, 'sso_invalid', '対応する検証鍵が見つかりません(kid不一致)');
  }
  return key;
}

export interface AgencySsoLoginResult {
  userId: string;
  returnTo: string | null;
}

function isSafeInternalPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
}

function stringClaim(payload: jwt.JwtPayload, key: string): string | null {
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// 仕様書外の拡張(Googleログイン等と同じJITプロビジョニング): 先方の署名済みトークンは
// 信頼できる主張とみなし、対応する代理店・ログインアカウントが無ければトークンの
// クレーム(agency_name/contact_email/actor_*)からその場で作成する。連携APIの
// login_email送信を待たなくてもSSO単体でログインできるようにする。
async function resolveOrProvisionAgency(sub: string, payload: jwt.JwtPayload): Promise<Agency> {
  const existing = await prisma.agency.findUnique({ where: { externalId: sub } });
  if (existing) {
    if (existing.status !== 'active') {
      throw new HttpError(403, 'agency_inactive', 'この代理店は停止中です');
    }
    return existing;
  }

  const agencyName = stringClaim(payload, 'agency_name') ?? sub;
  try {
    return await prisma.$transaction(async (tx) => {
      const code = await generateAgencyCode(tx);
      return tx.agency.create({
        data: { name: agencyName, code, externalId: sub, status: 'active', defaultCommissionRate: 0 },
      });
    });
  } catch (e) {
    // 同一subの初回SSOが二重タブ等で競合した場合、片方はexternalIdのユニーク制約に
    // 引っかかる。500にせず、先に作成された方を取得して処理を続行する。
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const created = await prisma.agency.findUnique({ where: { externalId: sub } });
      if (created) return created;
    }
    throw e;
  }
}

async function resolveOrProvisionLoginUser(agency: Agency, payload: jwt.JwtPayload) {
  const existing = await prisma.user.findFirst({ where: { agencyId: agency.id, role: 'agency' } });
  if (existing) return existing;

  const email = stringClaim(payload, 'actor_email') ?? stringClaim(payload, 'contact_email');
  if (!email) {
    throw new HttpError(401, 'agency_not_linked', 'ログイン用のメールアドレス情報がSSOトークンに含まれていません');
  }

  const existingByEmail = await prisma.user.findUnique({ where: { email } });
  if (existingByEmail) {
    // このメールが今まさに作ろうとしている代理店ログインアカウントそのもの(同一subの
    // 初回SSOが同時に処理された場合の競合)なら、衝突ではなく先に完了した方を返す。
    if (existingByEmail.role === 'agency' && existingByEmail.agencyId === agency.id) {
      return existingByEmail;
    }
    // それ以外(役割問わず別アカウント)は自動昇格させず、必ず連携API(login_email)経由の
    // 明示的な紐付けを要求する。SSOトークンのメールクレームだけを根拠に既存アカウントの
    // 権限を変更しない(未承認の権限昇格を避けるための保守的なデフォルト)。
    throw new HttpError(409, 'agency_not_linked', 'このメールアドレスは既に別のアカウントで使用されています');
  }

  const actorName = stringClaim(payload, 'actor_name') ?? agency.name;
  try {
    return await prisma.user.create({
      data: {
        name: actorName,
        email,
        // SSO経由のみでログインする想定のため、パスワードは平文で扱わずランダム値をハッシュ化するのみ
        // (仕様書v1.5 16章の原則を踏襲)。本人が通常ログインも使いたい場合はパスワード再設定から行う。
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
        role: 'agency',
        agencyId: agency.id,
      },
    });
  } catch (e) {
    // 同一メールでの初回SSOが二重タブ等で競合した場合、片方はemailのユニーク制約に
    // 引っかかる。500にせず、先に作成された方を取得して処理を続行する。
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const created = await prisma.user.findUnique({ where: { email } });
      if (created) return created;
    }
    throw e;
  }
}

export async function verifyAndConsumeAgencySsoToken(token: string): Promise<AgencySsoLoginResult> {
  const rawBaseUrl = await getSetting('external_agency_system_base_url');
  if (!rawBaseUrl) {
    throw new HttpError(503, 'sso_not_configured', 'SSO連携設定が未登録です');
  }
  const baseUrl = rawBaseUrl.replace(/\/$/, '');

  const kid = jwt.decode(token, { complete: true })?.header.kid;
  if (typeof kid !== 'string') {
    throw new HttpError(401, 'sso_invalid', 'SSOトークンの形式が不正です');
  }

  let payload: jwt.JwtPayload;
  try {
    const key = await getSigningKey(`${baseUrl}/api/sso/jwks.php`, kid);
    const decoded = jwt.verify(token, key, {
      issuer: baseUrl,
      audience: SSO_AUDIENCE,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });
    if (typeof decoded === 'string') {
      throw new HttpError(401, 'sso_invalid', 'SSOトークンの形式が不正です');
    }
    payload = decoded;
  } catch (e) {
    if (e instanceof jwt.TokenExpiredError) {
      throw new HttpError(401, 'sso_expired', 'SSOトークンの有効期限が切れています');
    }
    if (e instanceof HttpError) throw e;
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

  const agency = await resolveOrProvisionAgency(sub, payload);
  const user = await resolveOrProvisionLoginUser(agency, payload);

  return { userId: user.id, returnTo: isSafeInternalPath(payload.return_to) ? payload.return_to : null };
}
