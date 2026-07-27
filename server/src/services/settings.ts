import { prisma } from '../lib/prisma';
import { decryptSetting, encryptSetting } from '../lib/settingsCrypto';

// Stripe/Resend等、後から差し替えたい連携設定のキー一覧(仕様書外の拡張。CLAUDE.md追記参照)。
// DATABASE_URL/JWT_SECRETのような起動必須値はここに含めず.envのまま管理する。
export const SETTING_KEYS = [
  'stripe_secret_key',
  'stripe_webhook_secret',
  'stripe_public_key',
  'resend_api_key',
  'mail_from',
  'agency_api_key',
  'external_agency_system_base_url',
  'external_agency_system_api_key',
  // 仕様書外の拡張(NFT自動発行): 外部Mint APIプロバイダー(Crossmint等)の認証キー。
  'nft_mint_api_key',
  // 銀行振込(手動確認型)の案内文・有効/無効。他のキーと異なり秘密情報ではないため、
  // 管理画面では専用のbankTransferSettingsルートで平文のまま表示・編集する(マスク表示の対象外)。
  'bank_transfer_enabled',
  'bank_transfer_info',
  // 仕様書外の拡張(千ノ国全体連携 共通インターフェース契約v1.1 DRAFT・2026-07-22指示書対応):
  // 代理店HUB(common_user resolve・referral capture/confirm)向けのHMAC認証情報・接続先。
  // 実送信自体はSENNOKUNI_INTEGRATION_ENABLED環境変数がtrueの場合のみ行われる(既定OFF)。
  'sennokuni_agency_hub_base_url',
  'sennokuni_hmac_key_id',
  'sennokuni_hmac_secret',
  // 仕様書外の拡張: Outbox dispatcherが送信先ごとに参照する接続先URL(未設定の送信先はスキップする)。
  'integration_endpoint_sengoku_passport',
  'integration_endpoint_ai_art_school',
  // 仕様書外の拡張(残課題指示書Stage7・9.2「正式URL」): 送信先ごとのイベント受信path。
  // 未設定時は暫定path(/shopping/webhook)を使う(既存の挙動を変えないデフォルト)。
  'integration_endpoint_path_sengoku_passport',
  'integration_endpoint_path_ai_art_school',
  // 仕様書外の拡張: OVE Walletは共通契約と異なる独自HMAC方式(X-OVE-*)を使うため、
  // 認証情報を分離して保持する(千ノ国全体統合実装報告書の既知の未対応事項を踏まえた設計)。
  'ove_wallet_base_url',
  'ove_wallet_api_key_id',
  'ove_wallet_hmac_secret',
  // 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)7・8・14章: 既存のove_wallet_*
  // (X-OVE-*方式・reward付与/取消専用)とは別に、Claim確認APIおよびdigital_collectible専用
  // Common Event API向けの認証情報・URLを分離して保持する(用途混同による誤送信・不正な
  // 権限昇格を避けるため)。
  'wallet_claim_web_base_url',
  'wallet_claim_inbound_key_id',
  'wallet_claim_inbound_hmac_secret',
  'ove_wallet_events_key_id',
  'ove_wallet_events_hmac_secret',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export async function getSetting(key: SettingKey): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return null;
  return decryptSetting(row.value);
}

export async function setSetting(key: SettingKey, value: string): Promise<void> {
  const encrypted = encryptSetting(value);
  await prisma.setting.upsert({
    where: { key },
    update: { value: encrypted },
    create: { key, value: encrypted },
  });
}

export async function getAllSettingsMasked(): Promise<Record<SettingKey, { configured: boolean; masked: string | null }>> {
  const rows = await prisma.setting.findMany({ where: { key: { in: [...SETTING_KEYS] } } });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  const result = {} as Record<SettingKey, { configured: boolean; masked: string | null }>;
  for (const key of SETTING_KEYS) {
    const raw = byKey.get(key);
    if (!raw) {
      result[key] = { configured: false, masked: null };
      continue;
    }
    const value = decryptSetting(raw);
    const visible = value.slice(-4);
    // 実際の値の長さをそのまま伏せ字数に反映すると、長いシークレットキーで
    // 伏せ字が非常に長くなり画面レイアウトが崩れるため、表示上は固定長にする。
    const maskLength = Math.min(Math.max(value.length - 4, 0), 8);
    result[key] = { configured: true, masked: `${'*'.repeat(maskLength)}${visible}` };
  }
  return result;
}
