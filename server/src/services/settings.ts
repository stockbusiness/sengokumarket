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
