import crypto from 'crypto';
import { isSennokuniIntegrationEnabled, getOveWalletCredentials } from './sennokuniIntegrationConfig';
import { buildOveWalletHeaders } from '../lib/oveWalletHmac';

const GRANT_PATH = '/api/v1/rewards/grant';
const REVERSE_PATH_PREFIX = '/api/v1/transactions/';
const FETCH_TIMEOUT_MS = 8000;

export interface GrantRewardInput {
  externalUserId: string; // OVE Wallet側のservice account解決キー(このシステムのuserId等)
  commonUserId: string | null;
  amount: number; // OVEポイント等の整数量。丸めない(共通契約10章)。
  rewardRuleId: string | null;
  idempotencyKey: string; // 冪等キー。同一注文・同一商品行に対して固定の値を渡すこと。
  correlationId: string;
}

export interface GrantRewardResult {
  transactionId: string;
}

// OVE Walletへのreward付与(SYSTEM_ANALYSIS_千ノ国ウォレット / 2026-07-22指示書対応)。
// Feature Flag無効、または接続情報未設定の場合は即座にnull。
export async function grantReward(input: GrantRewardInput): Promise<GrantRewardResult | null> {
  if (!isSennokuniIntegrationEnabled()) return null;

  const credentials = await getOveWalletCredentials();
  if (!credentials) return null;

  const method = 'POST';
  const rawBody = JSON.stringify({
    source_system_key: 'sengoku-market',
    external_user_id: input.externalUserId,
    common_user_id: input.commonUserId,
    amount: input.amount,
    reward_rule_id: input.rewardRuleId,
    idempotency_key: input.idempotencyKey,
    correlation_id: input.correlationId,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const headers = buildOveWalletHeaders({ apiKeyId: credentials.apiKeyId, secret: credentials.secret, timestamp, nonce, method, path: GRANT_PATH, rawBody });

  let res: Response;
  try {
    res = await fetch(`${credentials.baseUrl}${GRANT_PATH}`, {
      method,
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error('OVE wallet reward grant request failed', e);
    return null;
  }

  if (!res.ok) {
    console.error('OVE wallet reward grant returned non-2xx', { status: res.status });
    return null;
  }

  const json = (await res.json().catch(() => null)) as { transaction_id?: unknown } | null;
  if (!json || typeof json.transaction_id !== 'string' || !json.transaction_id) return null;
  return { transactionId: json.transaction_id };
}

// 返金時のOVE取消(REVERSAL)。原付与のtransaction_idを指定する(仕様書外の拡張・共通契約12章
// 「権利取消・OVE reversalは原付与元…だけ許可する」に対応)。
export async function reverseReward(transactionId: string, reason: string): Promise<boolean> {
  if (!isSennokuniIntegrationEnabled()) return false;

  const credentials = await getOveWalletCredentials();
  if (!credentials) return false;

  const method = 'POST';
  const path = `${REVERSE_PATH_PREFIX}${transactionId}/reverse`;
  const rawBody = JSON.stringify({ source_system_key: 'sengoku-market', reason });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const headers = buildOveWalletHeaders({ apiKeyId: credentials.apiKeyId, secret: credentials.secret, timestamp, nonce, method, path, rawBody });

  let res: Response;
  try {
    res = await fetch(`${credentials.baseUrl}${path}`, {
      method,
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error('OVE wallet reward reversal request failed', e);
    return false;
  }

  if (!res.ok) {
    console.error('OVE wallet reward reversal returned non-2xx', { status: res.status });
    return false;
  }

  return true;
}
