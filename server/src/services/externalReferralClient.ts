import crypto from 'crypto';
import { isSennokuniIntegrationEnabled, getSennokuniHubCredentials } from './sennokuniIntegrationConfig';
import { buildSennokuniHeaders } from '../lib/sennokuniHmac';

const SYSTEM_KEY = 'sengoku-market';
const CAPTURE_PATH = '/api/referrals/capture';
const CONFIRM_PATH = '/api/referrals/confirm';
const FETCH_TIMEOUT_MS = 8000;

export interface CaptureReferralResult {
  canonicalReferralToken: string;
  referralSessionKey: string;
  agencyId: string;
  expiresAt: string | null;
}

// referral_token capture(共通契約v1.1 DRAFT 5章 / 2026-07-22指示書対応)。
// このシステムの`referral_links.code`を代理店HUBのcanonical_referral_tokenへ変換する。
// Feature Flag無効、または接続情報未設定の場合は即座にnull(呼び出し側は既存どおり
// referral_links.codeのみでの解決を続ける。既存の紹介・報酬フローには一切影響しない)。
export async function captureReferralToken(orderId: string, rawRefValue: string): Promise<CaptureReferralResult | null> {
  if (!isSennokuniIntegrationEnabled()) return null;

  const credentials = await getSennokuniHubCredentials();
  if (!credentials) return null;

  const method = 'POST';
  const rawBody = JSON.stringify({ system_key: SYSTEM_KEY, token: rawRefValue });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  // 本番安定化指示書Stage5(8.2): 同じ注文に対する再試行が外部側で重複captureとならないよう、
  // 固定のIdempotency-Keyを送る。
  const idempotencyKey = `referral-capture:${orderId}`;
  const headers = buildSennokuniHeaders({
    keyId: credentials.keyId,
    secret: credentials.secret,
    timestamp,
    nonce,
    method,
    path: CAPTURE_PATH,
    rawBody,
    eventVersion: '1.0',
    idempotencyKey,
  });

  let res: Response;
  try {
    res = await fetch(`${credentials.baseUrl}${CAPTURE_PATH}`, {
      method,
      headers,
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
    status?: unknown;
    canonical_referral_token?: unknown;
    referral_session_key?: unknown;
    agency_id?: unknown;
    expires_at?: unknown;
  } | null;

  if (
    !json ||
    json.status !== 'captured' ||
    typeof json.canonical_referral_token !== 'string' ||
    typeof json.referral_session_key !== 'string' ||
    typeof json.agency_id !== 'string'
  ) {
    return null;
  }

  return {
    canonicalReferralToken: json.canonical_referral_token,
    referralSessionKey: json.referral_session_key,
    agencyId: json.agency_id,
    expiresAt: typeof json.expires_at === 'string' ? json.expires_at : null,
  };
}

export interface ConfirmReferralInput {
  orderId: string;
  referralSessionKey: string;
  commonUserId: string;
  event: 'registration' | 'purchase';
}

export interface ConfirmReferralResult {
  commonUserId: string;
  registrationReferrerAgencyId: string | null;
  assignedAgencyId: string | null;
  salesAgentId: string | null;
  closingAgentId: string | null;
}

// referral confirm(共通契約v1.1 DRAFT 5章)。capture済みのreferral_session_keyとcommon_user_id
// を紐付け、代理店4役(registration_referrer/assigned/sales/closing)を確定させる。
// Feature Flag無効・接続情報未設定時はnull(既存フローには影響しない)。
export async function confirmReferral(input: ConfirmReferralInput): Promise<ConfirmReferralResult | null> {
  if (!isSennokuniIntegrationEnabled()) return null;

  const credentials = await getSennokuniHubCredentials();
  if (!credentials) return null;

  const method = 'POST';
  const rawBody = JSON.stringify({
    system_key: SYSTEM_KEY,
    referral_session_key: input.referralSessionKey,
    common_user_id: input.commonUserId,
    event: input.event,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  // 本番安定化指示書Stage5(8.2): 同じ注文に対する再試行が外部側で重複confirmとならないよう、
  // 固定のIdempotency-Keyを送る。このシステムはevent=purchaseのconfirmのみ発行する
  // (registration confirmのjob typeは未実装。将来追加する場合はreferral-confirm-registration:
  // <user_id>形式にする)。
  const idempotencyKey = `referral-confirm-purchase:${input.orderId}`;
  const headers = buildSennokuniHeaders({
    keyId: credentials.keyId,
    secret: credentials.secret,
    timestamp,
    nonce,
    method,
    path: CONFIRM_PATH,
    rawBody,
    eventVersion: '1.0',
    idempotencyKey,
  });

  let res: Response;
  try {
    res = await fetch(`${credentials.baseUrl}${CONFIRM_PATH}`, {
      method,
      headers,
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

  // 購入後代理店システム連携実装指示書 6.8・8.2章「受理条件」: status='confirmed'を必須と
  // しない(ok===trueを正とし、旧仕様のstatus='confirmed'のみの応答にも後方互換で対応する)。
  const succeeded = json?.ok === true || json?.status === 'confirmed';
  if (!json || !succeeded || typeof json.common_user_id !== 'string') {
    return null;
  }

  return {
    commonUserId: json.common_user_id,
    ...extractAgencyRoleFields(json),
  };
}

interface ConfirmReferralResponseBody {
  ok?: unknown;
  status?: unknown;
  common_user_id?: unknown;
  transaction?: unknown;
  // 8.2章「互換期間はagency_id、relation、agency_relationsも返してよい」: 代理店4役は
  // トップレベル(正式契約)・agency_assignment・relationのいずれかに入っている可能性がある。
  agency_assignment?: Record<string, unknown>;
  relation?: Record<string, unknown>;
  registration_referrer_agency_id?: unknown;
  assigned_agency_id?: unknown;
  sales_agent_id?: unknown;
  closing_agent_id?: unknown;
}

function extractAgencyRoleFields(json: ConfirmReferralResponseBody): {
  registrationReferrerAgencyId: string | null;
  assignedAgencyId: string | null;
  salesAgentId: string | null;
  closingAgentId: string | null;
} {
  const sources = [json, json.agency_assignment, json.relation].filter(
    (s): s is Record<string, unknown> => typeof s === 'object' && s !== null,
  );
  function pick(key: string): string | null {
    for (const source of sources) {
      const value = source[key];
      if (typeof value === 'string') return value;
    }
    return null;
  }
  return {
    registrationReferrerAgencyId: pick('registration_referrer_agency_id'),
    assignedAgencyId: pick('assigned_agency_id'),
    salesAgentId: pick('sales_agent_id'),
    closingAgentId: pick('closing_agent_id'),
  };
}
