import { isSennokuniIntegrationEnabled, getSennokuniAgencyHubApiCredentials } from './sennokuniIntegrationConfig';

// 代理店HUB(sengoku-ai.com)向けreferral capture/confirmクライアント。2026-10に先方の開発者向け
// ガイド・個別確認で判明した実際の契約(x-api-key認証、system_key='sengoku-rr'(サイト識別子)・
// project_key='sengoku-market'(戦国マーケット全体で1つの導線として固定)・agent_id/agency_idの
// フィールド名)に合わせて書き直したもの。このシステムの`referral_links.code`を代理店HUBの
// canonical_referral_tokenへ変換する。Feature Flag無効、または接続情報未設定の場合は即座にnull
// (呼び出し側は既存どおりreferral_links.codeのみでの解決を続ける。既存の紹介・報酬フローには
// 一切影響しない)。
const SYSTEM_KEY = 'sengoku-rr';
const PROJECT_KEY = 'sengoku-market';
const CAPTURE_PATH = '/api/referrals/capture';
const CONFIRM_PATH = '/api/referrals/confirm';
const FETCH_TIMEOUT_MS = 8000;

export interface CaptureReferralResult {
  canonicalReferralToken: string;
  referralSessionKey: string;
  agentId: string;
  expiresAt: string | null;
}

export async function captureReferralToken(rawRefValue: string): Promise<CaptureReferralResult | null> {
  if (!isSennokuniIntegrationEnabled()) return null;

  const credentials = await getSennokuniAgencyHubApiCredentials();
  if (!credentials) return null;

  const rawBody = JSON.stringify({ system_key: SYSTEM_KEY, referral_token: rawRefValue });

  let res: Response;
  try {
    res = await fetch(`${credentials.baseUrl}${CAPTURE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': credentials.apiKey },
      body: rawBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error('referral capture request failed', e);
    return null;
  }

  if (!res.ok) {
    console.error('referral capture returned non-2xx', { status: res.status });
    return null;
  }

  const json = (await res.json().catch(() => null)) as {
    ok?: unknown;
    canonical_referral_token?: unknown;
    referral_session_key?: unknown;
    agent_id?: unknown;
    expires_at?: unknown;
  } | null;

  if (
    !json ||
    json.ok !== true ||
    typeof json.canonical_referral_token !== 'string' ||
    typeof json.referral_session_key !== 'string' ||
    (typeof json.agent_id !== 'string' && typeof json.agent_id !== 'number')
  ) {
    return null;
  }

  return {
    canonicalReferralToken: json.canonical_referral_token,
    referralSessionKey: json.referral_session_key,
    agentId: String(json.agent_id),
    expiresAt: typeof json.expires_at === 'string' ? json.expires_at : null,
  };
}

export interface ConfirmReferralInput {
  orderId: string;
  referralSessionKey: string;
  commonUserId: string;
  // 代理店HUB側のユーザー解決に使うこのシステムのuser.id。ゲスト購入等でuserIdが無い注文では
  // 省略する(common_user_idだけでも紹介関係・transactionの確定は行える)。
  externalUserId?: string | null;
  // product_integration_rules.product_codeから解決した値。注文内の商品構成からは一意に
  // 決められない場合(複数商品・ルール未設定等)はnull(その場合product_codeは送らない。
  // 必須項目ではないため、省略してもtransaction自体は作成される)。
  productCode?: string | null;
  amountJpy: number;
}

export interface ConfirmReferralResult {
  commonUserId: string;
  registrationReferrerAgencyId: string | null;
  assignedAgencyId: string | null;
  salesAgentId: string | null;
  closingAgentId: string | null;
}

// referral confirm。capture済みのreferral_session_keyとcommon_user_idを紐付け、注文を
// transactionとして確定させる。代理店4役(registration_referrer/assigned/sales/closing)は
// 先方への個別確認(2026-10)により、レスポンス直下ではなくtransaction配下に入ることが判明した。
// registration_referrer_agency_idは紹介トークンから自動設定されるため送らない。assigned_agency_id
// も未指定時は紹介元代理店が自動的に入るため送らない。sales_agent_id/closing_agent_idは
// このシステム側に販売担当・クロージング担当を別管理する仕組みが無いため現状送らない
// (将来その仕組みができた場合はここから明示的に送る)。
// Feature Flag無効・接続情報未設定時はnull(既存フローには影響しない)。
export async function confirmReferral(input: ConfirmReferralInput): Promise<ConfirmReferralResult | null> {
  if (!isSennokuniIntegrationEnabled()) return null;

  const credentials = await getSennokuniAgencyHubApiCredentials();
  if (!credentials) return null;

  const rawBody = JSON.stringify({
    system_key: SYSTEM_KEY,
    session_key: input.referralSessionKey,
    external_user_id: input.externalUserId ?? undefined,
    project_key: PROJECT_KEY,
    common_user_id: input.commonUserId,
    order_id: input.orderId,
    product_code: input.productCode ?? undefined,
    payment_status: 'paid',
    amount: input.amountJpy,
    currency: 'JPY',
  });

  let res: Response;
  try {
    res = await fetch(`${credentials.baseUrl}${CONFIRM_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': credentials.apiKey },
      body: rawBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error('referral confirm request failed', e);
    return null;
  }

  if (!res.ok) {
    console.error('referral confirm returned non-2xx', { status: res.status });
    return null;
  }

  const json = (await res.json().catch(() => null)) as ConfirmReferralResponseBody | null;

  if (!json || json.ok !== true || typeof json.common_user_id !== 'string') {
    return null;
  }

  return {
    commonUserId: json.common_user_id,
    ...extractAgencyRoleFields(json),
  };
}

interface ConfirmReferralTransaction {
  registration_referrer_agency_id?: unknown;
  assigned_agency_id?: unknown;
  sales_agent_id?: unknown;
  closing_agent_id?: unknown;
}

interface ConfirmReferralResponseBody {
  ok?: unknown;
  common_user_id?: unknown;
  // order_id(今回は常に送信)がある場合にのみ作成される。無い場合は紹介関係の確定のみで
  // transactionは空になりうる(先方の2026-10回答より)。
  transaction?: ConfirmReferralTransaction;
}

function extractAgencyRoleFields(json: ConfirmReferralResponseBody): {
  registrationReferrerAgencyId: string | null;
  assignedAgencyId: string | null;
  salesAgentId: string | null;
  closingAgentId: string | null;
} {
  const t = json.transaction;
  function pick(key: keyof ConfirmReferralTransaction): string | null {
    const value = t?.[key];
    return typeof value === 'string' ? value : null;
  }
  return {
    registrationReferrerAgencyId: pick('registration_referrer_agency_id'),
    assignedAgencyId: pick('assigned_agency_id'),
    salesAgentId: pick('sales_agent_id'),
    closingAgentId: pick('closing_agent_id'),
  };
}
