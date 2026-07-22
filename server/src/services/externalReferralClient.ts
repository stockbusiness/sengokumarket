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
export async function captureReferralToken(rawRefValue: string): Promise<CaptureReferralResult | null> {
  if (!isSennokuniIntegrationEnabled()) return null;

  const credentials = await getSennokuniHubCredentials();
  if (!credentials) return null;

  const method = 'POST';
  const rawBody = JSON.stringify({ system_key: SYSTEM_KEY, token: rawRefValue });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const headers = buildSennokuniHeaders({
    keyId: credentials.keyId,
    secret: credentials.secret,
    timestamp,
    nonce,
    method,
    path: CAPTURE_PATH,
    rawBody,
    eventVersion: '1.0',
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
  const headers = buildSennokuniHeaders({
    keyId: credentials.keyId,
    secret: credentials.secret,
    timestamp,
    nonce,
    method,
    path: CONFIRM_PATH,
    rawBody,
    eventVersion: '1.0',
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

  const json = (await res.json().catch(() => null)) as {
    status?: unknown;
    common_user_id?: unknown;
    registration_referrer_agency_id?: unknown;
    assigned_agency_id?: unknown;
    sales_agent_id?: unknown;
    closing_agent_id?: unknown;
  } | null;

  if (!json || json.status !== 'confirmed' || typeof json.common_user_id !== 'string') {
    return null;
  }

  return {
    commonUserId: json.common_user_id,
    registrationReferrerAgencyId: typeof json.registration_referrer_agency_id === 'string' ? json.registration_referrer_agency_id : null,
    assignedAgencyId: typeof json.assigned_agency_id === 'string' ? json.assigned_agency_id : null,
    salesAgentId: typeof json.sales_agent_id === 'string' ? json.sales_agent_id : null,
    closingAgentId: typeof json.closing_agent_id === 'string' ? json.closing_agent_id : null,
  };
}
