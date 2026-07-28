import crypto from 'crypto';
import { isSennokuniIntegrationEnabled, getSennokuniHubCredentials } from './sennokuniIntegrationConfig';
import { buildSennokuniHeaders } from '../lib/sennokuniHmac';

const SYSTEM_KEY = 'sengoku-market';
const RESOLVE_PATH = '/api/common-users/resolve';
const FETCH_TIMEOUT_MS = 8000;

export interface ResolveCommonUserInput {
  // このシステム内のユーザーID(external_user_idとして送信する)。
  externalUserId: string;
  name: string;
  email: string;
  // 購入後代理店システム連携実装指示書 6.7・8.1章: このシステムには現状メールアドレスの
  // 所有確認(検証リンク等)フローが無いため、常にfalseを送る(未検証を偽って「検証済み」と
  // 送ることはしない)。
  emailVerified: boolean;
  phone?: string | null;
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
  // 購入後代理店システム連携実装指示書 6.7・8.1章: 正式契約のキー名(system_key・
  // external_user_id・name・email・email_verified・phone・create_if_missing)へ統一する。
  // 旧キー(verified_email・verified_phone)は送らない(受信側の互換期間対応に依存しない)。
  const rawBody = JSON.stringify({
    system_key: SYSTEM_KEY,
    external_user_id: input.externalUserId,
    name: input.name,
    email: input.email,
    email_verified: input.emailVerified,
    phone: input.phone ?? undefined,
    create_if_missing: true,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  // 本番安定化指示書Stage5(8.2): 同じuser_idに対する再試行が外部側で重複解決とならないよう、
  // 固定のIdempotency-Keyを送る。
  const idempotencyKey = `common-user-resolve:${input.externalUserId}`;
  const headers = buildSennokuniHeaders({
    keyId: credentials.keyId,
    secret: credentials.secret,
    timestamp,
    nonce,
    method,
    path: RESOLVE_PATH,
    rawBody,
    eventVersion: '1.0',
    idempotencyKey,
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
