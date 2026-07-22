import crypto from 'crypto';
import { isSennokuniIntegrationEnabled, getSennokuniHubCredentials } from './sennokuniIntegrationConfig';
import { buildSennokuniHeaders } from '../lib/sennokuniHmac';
import { prisma } from '../lib/prisma';

const SYSTEM_KEY = 'sengoku-market';
const RESOLVE_PATH = '/api/common-users/resolve';
const FETCH_TIMEOUT_MS = 8000;

export interface ResolveCommonUserInput {
  // このシステム内のユーザーID(external_user_idとして送信する)。
  externalUserId: string;
  verifiedEmail?: string | null;
  verifiedPhone?: string | null;
}

export interface ResolveCommonUserResult {
  commonUserId: string;
}

// common_user_id解決クライアント(共通契約v1.1 DRAFT 4.1章 / 2026-07-22指示書対応)。
// SENNOKUNI_INTEGRATION_ENABLEDが無効、または接続情報が未設定の場合は即座にnullを返し、
// 呼び出し側は既存どおりcommonUserResolutionStatus='unresolved'のまま処理を続ける
// (実HTTP送信が発生しないため、既存の登録・購入フローへの影響はない)。
export async function resolveCommonUserId(input: ResolveCommonUserInput): Promise<ResolveCommonUserResult | null> {
  if (!isSennokuniIntegrationEnabled()) return null;

  const credentials = await getSennokuniHubCredentials();
  if (!credentials) return null;

  const method = 'POST';
  const rawBody = JSON.stringify({
    system_key: SYSTEM_KEY,
    external_user_id: input.externalUserId,
    verified_email: input.verifiedEmail ?? undefined,
    verified_phone: input.verifiedPhone ?? undefined,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const headers = buildSennokuniHeaders({
    keyId: credentials.keyId,
    secret: credentials.secret,
    timestamp,
    nonce,
    method,
    path: RESOLVE_PATH,
    rawBody,
    eventVersion: '1.0',
  });

  let res: Response;
  try {
    res = await fetch(`${credentials.baseUrl}${RESOLVE_PATH}`, {
      method,
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error('common_user_id resolve request failed', e);
    return null;
  }

  if (!res.ok) {
    console.error('common_user_id resolve returned non-2xx', { status: res.status });
    return null;
  }

  const json = (await res.json().catch(() => null)) as { common_user_id?: unknown } | null;
  if (!json || typeof json.common_user_id !== 'string' || !json.common_user_id) return null;
  return { commonUserId: json.common_user_id };
}

// 登録・購入等のDBトランザクション完了「後」に呼ぶベストエフォート版。トランザクション内で
// 外部HTTP呼び出しを待つと、決済・在庫更新のロック保持時間が外部APIの応答速度に左右されて
// しまうため(仕様書v1.5 7.6の「メール送信はトランザクション外」と同じ方針)、必ずコミット後・
// 例外を握りつぶした形で呼び出すこと。Feature Flag無効時は内部のresolveCommonUserIdが
// 即座にnullを返すため、既存フローへの追加コストは実質ゼロ。
export async function bestEffortResolveAndLinkCommonUserId(userId: string, email: string | null): Promise<void> {
  if (!isSennokuniIntegrationEnabled()) return;

  try {
    const resolved = await resolveCommonUserId({ externalUserId: userId, verifiedEmail: email });
    if (!resolved) return;
    await prisma.user.update({ where: { id: userId }, data: { commonUserId: resolved.commonUserId } });
  } catch (e) {
    console.error('common_user_id best-effort resolve/link failed', { userId, error: e });
  }
}
