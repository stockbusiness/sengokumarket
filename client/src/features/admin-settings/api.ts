import { adminFetch, adminSend } from '../../shared/api/adminClient';

export interface AdminSettingInfo {
  configured: boolean;
  masked: string | null;
}
export interface AdminSettings {
  stripe_secret_key: AdminSettingInfo;
  stripe_webhook_secret: AdminSettingInfo;
  stripe_public_key: AdminSettingInfo;
  resend_api_key: AdminSettingInfo;
  mail_from: AdminSettingInfo;
  agency_api_key: AdminSettingInfo;
  external_agency_system_base_url: AdminSettingInfo;
  external_agency_system_api_key: AdminSettingInfo;
  // 仕様書外の拡張(NFT自動発行): 外部Mint APIプロバイダーの認証キー。
  nft_mint_api_key: AdminSettingInfo;
}

export function fetchAdminSettings() {
  return adminFetch<{ settings: AdminSettings }>('/settings');
}

export function updateAdminSettings(payload: Partial<Record<keyof AdminSettings, string>>) {
  return adminSend<{ settings: AdminSettings }>('PUT', '/settings', payload);
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

export function testStripeConnection(stripeSecretKey: string) {
  return adminSend<ConnectionTestResult>('POST', '/settings/test/stripe', { stripe_secret_key: stripeSecretKey });
}

export function testResendConnection(resendApiKey: string, mailFrom: string, to: string) {
  return adminSend<ConnectionTestResult>('POST', '/settings/test/resend', {
    resend_api_key: resendApiKey,
    mail_from: mailFrom,
    to,
  });
}

export function testExternalAgencyConnection(baseUrl: string, apiKey: string) {
  return adminSend<ConnectionTestResult>('POST', '/settings/test/external-agency', {
    external_agency_system_base_url: baseUrl,
    external_agency_system_api_key: apiKey,
  });
}

export function testAgencyKeyConnection(agencyApiKey: string) {
  return adminSend<ConnectionTestResult>('POST', '/settings/test/agency-key', { agency_api_key: agencyApiKey });
}

export function testNftMintConnection(nftMintApiKey: string) {
  return adminSend<ConnectionTestResult>('POST', '/settings/test/nft-mint', { nft_mint_api_key: nftMintApiKey });
}

// --- 銀行振込設定(仕様書外の拡張) ---
export interface BankTransferSettings {
  enabled: boolean;
  info: string;
}

export function fetchBankTransferSettings() {
  return adminFetch<BankTransferSettings>('/bank-transfer-settings');
}

export function updateBankTransferSettings(payload: BankTransferSettings) {
  return adminSend<BankTransferSettings>('PUT', '/bank-transfer-settings', payload);
}
