import { getSetting } from './settings';

// 購入後代理店システム連携実装指示書 14章: 2つの独立したFeature Flag。
// PURCHASE_PROVISIONING_ENABLED = 決済確定時のジョブ作成・外部API送信自体のマスタースイッチ。
// AGENCY_PORTAL_LOGIN_ENABLED = 購入完了画面・マイページ・通知メールにログイン導線を
// 表示するかどうか(ジョブ自体は先に有効化しつつ、UI公開は別タイミングにしたい場合を想定)。
// 既存のSENNOKUNI_INTEGRATION_ENABLED等と同じ「デプロイ時にしか変更できない環境変数のみの
// マスターキルスイッチ」方針を踏襲する(DB設定にしない)。
export function isPurchaseProvisioningEnabled(): boolean {
  return process.env.PURCHASE_PROVISIONING_ENABLED === 'true';
}

export function isAgencyPortalLoginEnabled(): boolean {
  return process.env.AGENCY_PORTAL_LOGIN_ENABLED === 'true';
}

export interface PurchaseProvisioningCredentials {
  keyId: string;
  secret: string;
  baseUrl: string;
}

// purchase-provisioning API(HMAC共通仕様v1.1)向けの認証情報。いずれか未設定ならnull
// (呼び出し側は「環境未設定」として安全にスキップする。既存のgetSennokuniHubCredentials等と
// 同じ設計)。
export async function getPurchaseProvisioningCredentials(): Promise<PurchaseProvisioningCredentials | null> {
  const [keyId, secret, baseUrl] = await Promise.all([
    getSetting('purchase_provisioning_hmac_key_id'),
    getSetting('purchase_provisioning_hmac_secret'),
    getSetting('purchase_provisioning_base_url'),
  ]);
  if (!keyId || !secret || !baseUrl) return null;
  return { keyId, secret, baseUrl: baseUrl.replace(/\/+$/, '') };
}
