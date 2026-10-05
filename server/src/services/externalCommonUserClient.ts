import { isSennokuniIntegrationEnabled, getSennokuniAgencyHubApiCredentials } from './sennokuniIntegrationConfig';

// 代理店HUB(sengoku-ai.com)側でこのシステムを識別するsite_key(先方の開発者向けガイドで
// 指定された固定値)。千ノ国ウォレット向けのsource_system_key('sengoku-market')とは別物。
const SYSTEM_KEY = 'sengoku-rr';
// 2026-10の先方確認: 末尾スラッシュ無しだと301で末尾スラッシュ付きURLへリダイレクトされ、
// その際にPOSTがGETへ変わってしまう(fetchは301/302リダイレクトでPOSTをGETに変える仕様)ため
// 404に見える。リダイレクトを発生させないよう、最初から末尾スラッシュ付きで直接呼ぶ。
const RESOLVE_PATH = '/api/common-users/resolve/';
const FETCH_TIMEOUT_MS = 8000;

export interface ResolveCommonUserInput {
  // このシステム内のユーザーID(external_user_idとして送信する)。
  externalUserId: string;
  name: string;
  email: string;
  phone?: string | null;
}

export interface ResolveCommonUserResult {
  commonUserId: string;
}

// common_user_id解決クライアント。代理店HUB(sengoku-ai.com)の開発者向けガイド(2026-10)で
// 確認した実際の契約に準拠する: 認証はx-api-keyヘッダー1本(HMACではない)、リクエストボディは
// system_key/external_user_id/display_name/email/phone/create_if_missing、レスポンス直下の
// common_user_idを読む。
// SENNOKUNI_INTEGRATION_ENABLEDが無効、または接続情報が未設定の場合は即座にnullを返し、
// 呼び出し側は既存どおりcommonUserResolutionStatus='unresolved'のまま処理を続ける
// (実HTTP送信が発生しないため、既存の登録・購入フローへの影響はない)。
export async function resolveCommonUserId(input: ResolveCommonUserInput): Promise<ResolveCommonUserResult | null> {
  if (!isSennokuniIntegrationEnabled()) return null;

  const credentials = await getSennokuniAgencyHubApiCredentials();
  if (!credentials) return null;

  const rawBody = JSON.stringify({
    system_key: SYSTEM_KEY,
    external_user_id: input.externalUserId,
    display_name: input.name,
    email: input.email,
    phone: input.phone ?? undefined,
    create_if_missing: true,
  });

  let res: Response;
  try {
    res = await fetch(`${credentials.baseUrl}${RESOLVE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': credentials.apiKey,
      },
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

  const json = (await res.json().catch(() => null)) as { ok?: unknown; common_user_id?: unknown } | null;
  if (!json || typeof json.common_user_id !== 'string' || !json.common_user_id) return null;
  return { commonUserId: json.common_user_id };
}
