import crypto from 'crypto';
import { isPurchaseProvisioningEnabled, getPurchaseProvisioningCredentials } from './purchaseProvisioningConfig';
import { buildSennokuniHeaders } from '../lib/sennokuniHmac';

const SYSTEM_KEY = 'sengoku-market';
const PROVISION_PATH = '/api/purchase-provisioning';
const REVOKE_PATH = '/api/purchase-provisioning/revoke';
const FETCH_TIMEOUT_MS = 8000;
const EVENT_VERSION = '1.0';

// 購入後代理店システム連携実装指示書 5.2章の入力形式。
export interface PurchaseProvisioningRequestInput {
  eventId: string;
  correlationId: string | null;
  commonUserId: string;
  externalUserId: string;
  user: {
    name: string;
    email: string;
    emailVerified: boolean;
    phone: string | null;
  };
  order: {
    orderId: string;
    orderNumber: string;
    paymentStatus: string;
    totalAmount: number;
    paidAt: string | null;
  };
  items: Array<{
    orderItemId: string;
    productId: string;
    productCode: string | null;
    productName: string;
    quantity: number;
    unitPrice: number;
    subtotal: number;
    entitlementStatus: string;
    agencyAccessMode: string;
    agencyRole: string | null;
  }>;
  agencyAssignment: {
    registrationReferrerAgencyId: string | null;
    assignedAgencyId: string | null;
    salesAgentId: string | null;
    closingAgentId: string | null;
    referralSessionKey: string | null;
  };
  loginProvisioning: {
    requested: boolean;
    mode: 'sso' | 'password_setup';
    returnUrl: string | null;
  };
}

// 5.3章のレスポンス形式のうち、Market側で必要な項目のみ抽出する。
export interface PurchaseProvisioningResult {
  commonUserId: string;
  transactionId: string | null;
  accountType: string | null;
  accountId: string | null;
  loginEmail: string | null;
  accountStatus: string | null;
  accessMode: string | null;
  loginUrl: string | null;
  loginUrlExpiresAt: string | null;
}

function buildRequestBody(input: PurchaseProvisioningRequestInput): Record<string, unknown> {
  return {
    event_id: input.eventId,
    event_version: EVENT_VERSION,
    source_system_key: SYSTEM_KEY,
    correlation_id: input.correlationId ?? undefined,
    common_user_id: input.commonUserId,
    external_user_id: input.externalUserId,
    user: {
      name: input.user.name,
      email: input.user.email,
      email_verified: input.user.emailVerified,
      phone: input.user.phone ?? undefined,
    },
    order: {
      order_id: input.order.orderId,
      order_number: input.order.orderNumber,
      payment_status: input.order.paymentStatus,
      currency: 'JPY',
      total_amount: input.order.totalAmount,
      paid_at: input.order.paidAt ?? undefined,
    },
    items: input.items.map((item) => ({
      order_item_id: item.orderItemId,
      product_id: item.productId,
      product_code: item.productCode ?? undefined,
      product_name: item.productName,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      subtotal: item.subtotal,
      entitlement_status: item.entitlementStatus,
      agency_access_mode: item.agencyAccessMode,
      agency_role: item.agencyRole ?? undefined,
    })),
    agency_assignment: {
      registration_referrer_agency_id: input.agencyAssignment.registrationReferrerAgencyId ?? undefined,
      assigned_agency_id: input.agencyAssignment.assignedAgencyId ?? undefined,
      sales_agent_id: input.agencyAssignment.salesAgentId ?? undefined,
      closing_agent_id: input.agencyAssignment.closingAgentId ?? undefined,
      referral_session_key: input.agencyAssignment.referralSessionKey ?? undefined,
    },
    login_provisioning: {
      requested: input.loginProvisioning.requested,
      mode: input.loginProvisioning.mode,
      return_url: input.loginProvisioning.returnUrl ?? undefined,
    },
  };
}

interface ProvisioningResponseBody {
  ok?: unknown;
  common_user_id?: unknown;
  transaction?: { transaction_id?: unknown };
  account?: { account_type?: unknown; account_id?: unknown; login_email?: unknown; status?: unknown };
  access?: { mode?: unknown; login_url?: unknown; expires_at?: unknown };
}

function parseProvisioningResponse(json: ProvisioningResponseBody | null): PurchaseProvisioningResult | null {
  if (!json || json.ok !== true || typeof json.common_user_id !== 'string') return null;
  return {
    commonUserId: json.common_user_id,
    transactionId: typeof json.transaction?.transaction_id === 'string' ? json.transaction.transaction_id : null,
    accountType: typeof json.account?.account_type === 'string' ? json.account.account_type : null,
    accountId: typeof json.account?.account_id === 'string' ? json.account.account_id : null,
    loginEmail: typeof json.account?.login_email === 'string' ? json.account.login_email : null,
    accountStatus: typeof json.account?.status === 'string' ? json.account.status : null,
    accessMode: typeof json.access?.mode === 'string' ? json.access.mode : null,
    loginUrl: typeof json.access?.login_url === 'string' ? json.access.login_url : null,
    loginUrlExpiresAt: typeof json.access?.expires_at === 'string' ? json.access.expires_at : null,
  };
}

// 購入者アカウント発行(POST /api/purchase-provisioning)。Feature Flag無効・接続情報未設定
// 時はnull(呼び出し側は既存の千ノ国連携クライアントと同様、実送信せず安全にスキップする)。
export async function requestPurchaseProvisioning(input: PurchaseProvisioningRequestInput): Promise<PurchaseProvisioningResult | null> {
  if (!isPurchaseProvisioningEnabled()) return null;

  const credentials = await getPurchaseProvisioningCredentials();
  if (!credentials) return null;

  const method = 'POST';
  const rawBody = JSON.stringify(buildRequestBody(input));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  // 5.2章: Idempotency-Key = purchase-provisioning:<order_id>(同一注文の再試行が
  // 外部側で重複アカウント作成・重複transaction保存とならないようにする)。
  const idempotencyKey = `purchase-provisioning:${input.order.orderId}`;
  const headers = buildSennokuniHeaders({
    keyId: credentials.keyId,
    secret: credentials.secret,
    timestamp,
    nonce,
    method,
    path: PROVISION_PATH,
    rawBody,
    eventVersion: EVENT_VERSION,
    idempotencyKey,
    correlationId: input.correlationId ?? undefined,
  });

  let res: Response;
  try {
    res = await fetch(`${credentials.baseUrl}${PROVISION_PATH}`, {
      method,
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error('purchase provisioning request failed', e);
    return null;
  }

  if (!res.ok) {
    console.error('purchase provisioning returned non-2xx', { status: res.status });
    return null;
  }

  const json = (await res.json().catch(() => null)) as ProvisioningResponseBody | null;
  return parseProvisioningResponse(json);
}

export interface RevokePurchaseProvisioningInput {
  eventId: string;
  orderId: string;
  commonUserId: string;
  reason: 'full_refund';
}

// 全額返金時の権利取消・アカウントアクセス停止(POST /api/purchase-provisioning/revoke、10章)。
export async function revokePurchaseProvisioning(input: RevokePurchaseProvisioningInput): Promise<boolean> {
  if (!isPurchaseProvisioningEnabled()) return false;

  const credentials = await getPurchaseProvisioningCredentials();
  if (!credentials) return false;

  const method = 'POST';
  const rawBody = JSON.stringify({
    event_id: input.eventId,
    source_system_key: SYSTEM_KEY,
    order_id: input.orderId,
    common_user_id: input.commonUserId,
    reason: input.reason,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const idempotencyKey = `purchase-provisioning-revoke:${input.orderId}`;
  const headers = buildSennokuniHeaders({
    keyId: credentials.keyId,
    secret: credentials.secret,
    timestamp,
    nonce,
    method,
    path: REVOKE_PATH,
    rawBody,
    eventVersion: EVENT_VERSION,
    idempotencyKey,
  });

  let res: Response;
  try {
    res = await fetch(`${credentials.baseUrl}${REVOKE_PATH}`, {
      method,
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error('purchase provisioning revoke request failed', e);
    return false;
  }

  if (!res.ok) {
    console.error('purchase provisioning revoke returned non-2xx', { status: res.status });
    return false;
  }

  const json = (await res.json().catch(() => null)) as { ok?: unknown } | null;
  return json?.ok === true;
}
