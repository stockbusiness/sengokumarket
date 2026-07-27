import { getSetting } from './settings';

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)18章: 既定falseの
// Feature Flag。既存のSENNOKUNI_INTEGRATION_ENABLED/sennokuni_integration_stageとは独立に、
// この機能単独でON/OFFできるようにする(この機能を止めても他の千ノ国連携に影響させないため)。
export function isWalletClaimEnabled(): boolean {
  return process.env.ENABLE_WALLET_CLAIM === 'true';
}

export function isDigitalCollectibleDeliveryEnabled(): boolean {
  return process.env.ENABLE_DIGITAL_COLLECTIBLE_DELIVERY === 'true';
}

// 千ノ国ウォレット側の受取ページ(このシステムのドメインではない)。
// 購入完了メール・マイページのClaim URL表示に使う。
export async function getWalletClaimWebBaseUrl(): Promise<string | null> {
  const value = await getSetting('wallet_claim_web_base_url');
  return value ? value.replace(/\/+$/, '') : null;
}

export interface WalletClaimInboundCredentials {
  keyId: string;
  secret: string;
}

// Claim確認API(GET/POST /api/integrations/wallet-claims/...)を呼び出す千ノ国ウォレット側の
// 専用system key。既存のsennokuni_hmac_key_id(代理店HUB向け)・ove_wallet_api_key_id
// (reward付与/取消向け、X-OVE-*方式)のいずれとも異なる、この用途専用の鍵。
export async function getWalletClaimInboundCredentials(): Promise<WalletClaimInboundCredentials | null> {
  const [keyId, secret] = await Promise.all([
    getSetting('wallet_claim_inbound_key_id'),
    getSetting('wallet_claim_inbound_hmac_secret'),
  ]);
  if (!keyId || !secret) return null;
  return { keyId, secret };
}

export interface OveWalletEventsCredentials {
  keyId: string;
  secret: string;
  baseUrl: string;
}

// digital_collectible専用送信(sendDigitalCollectibleToOveWallet)向けのCommon Event API認証情報。
// 送信先ホスト自体はreward付与/取消と同じove_wallet_base_urlを再利用するが、署名方式は
// X-OVE-*ではなく共通契約(X-SenNoKuni-*)形式のため、鍵は専用のものを別途要求する。
export async function getOveWalletEventsCredentials(): Promise<OveWalletEventsCredentials | null> {
  const [keyId, secret, baseUrl] = await Promise.all([
    getSetting('ove_wallet_events_key_id'),
    getSetting('ove_wallet_events_hmac_secret'),
    getSetting('ove_wallet_base_url'),
  ]);
  if (!keyId || !secret || !baseUrl) return null;
  return { keyId, secret, baseUrl: baseUrl.replace(/\/+$/, '') };
}
