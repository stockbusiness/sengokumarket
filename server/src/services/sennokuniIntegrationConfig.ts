import { getSetting } from './settings';

// 仕様書外の拡張(千ノ国全体連携 2026-07-22指示書対応): common_user resolve・referral
// capture/confirm・Outbox実送信は、統合責任者が署名テストベクトル・event version・本番URL/鍵を
// 確定し、この環境変数を明示的にtrueへ設定するまで常に無効(既定OFF)とする
// ("Feature Flagでdormantなコードとして実装"という方針)。無効時は各クライアント関数が
// 即座にnullを返し、外部への実HTTP送信は一切発生しない(既存の決済・登録フローへの影響はゼロ)。
export function isSennokuniIntegrationEnabled(): boolean {
  return process.env.SENNOKUNI_INTEGRATION_ENABLED === 'true';
}

export interface SennokuniHubCredentials {
  keyId: string;
  secret: string;
  baseUrl: string;
}

// 代理店HUB(common-users/resolve・referrals/capture・referrals/confirm)向けの認証情報。
// いずれか未設定ならnull(呼び出し側は「環境未設定」として安全にスキップする)。
export async function getSennokuniHubCredentials(): Promise<SennokuniHubCredentials | null> {
  const [keyId, secret, baseUrl] = await Promise.all([
    getSetting('sennokuni_hmac_key_id'),
    getSetting('sennokuni_hmac_secret'),
    getSetting('sennokuni_agency_hub_base_url'),
  ]);
  if (!keyId || !secret || !baseUrl) return null;
  return { keyId, secret, baseUrl: baseUrl.replace(/\/+$/, '') };
}

export interface OveWalletCredentials {
  apiKeyId: string;
  secret: string;
  baseUrl: string;
}

// OVE Walletは共通契約(X-SenNoKuni-*)とは別のHMAC方式・認証情報を使うため分離する。
export async function getOveWalletCredentials(): Promise<OveWalletCredentials | null> {
  const [apiKeyId, secret, baseUrl] = await Promise.all([
    getSetting('ove_wallet_api_key_id'),
    getSetting('ove_wallet_hmac_secret'),
    getSetting('ove_wallet_base_url'),
  ]);
  if (!apiKeyId || !secret || !baseUrl) return null;
  return { apiKeyId, secret, baseUrl: baseUrl.replace(/\/+$/, '') };
}

// Outbox dispatcherが送信先システムキーごとに参照する接続先URL。未対応・未設定の送信先はnull。
export async function getIntegrationEndpointBaseUrl(destinationSystemKey: string): Promise<string | null> {
  const key = ({
    'sengoku-passport': 'integration_endpoint_sengoku_passport',
    'ai-art-school': 'integration_endpoint_ai_art_school',
  } as const)[destinationSystemKey as 'sengoku-passport' | 'ai-art-school'];
  if (!key) return null;
  const value = await getSetting(key);
  return value ? value.replace(/\/+$/, '') : null;
}

// 仕様書外の拡張(残課題指示書Stage7・9.2「正式URL」): 送信先ごとのイベント受信path。
// 正式契約が確定していない間の暫定値として'/shopping/webhook'を既定にする(未設定時のみ)。
const PROVISIONAL_INTEGRATION_EVENT_PATH = '/shopping/webhook';

export async function getIntegrationEndpointPath(destinationSystemKey: string): Promise<string> {
  const key = ({
    'sengoku-passport': 'integration_endpoint_path_sengoku_passport',
    'ai-art-school': 'integration_endpoint_path_ai_art_school',
  } as const)[destinationSystemKey as 'sengoku-passport' | 'ai-art-school'];
  if (!key) return PROVISIONAL_INTEGRATION_EVENT_PATH;
  const value = await getSetting(key);
  return value || PROVISIONAL_INTEGRATION_EVENT_PATH;
}
