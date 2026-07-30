import { adminFetch, adminSend } from '../../shared/api/adminClient';

export interface AdminWalletMissing {
  id: string;
  userId: string | null;
  customerName: string;
  customerEmail: string;
  orderNumber: string;
  productName: string;
  purchasedAt: string;
  lastReminderSentAt: string | null;
  // 仕様書外の拡張: ウォレット登録用URLの発行状況(none/active/used/expired/revoked)。
  linkStatus: 'none' | 'active' | 'used' | 'expired' | 'revoked';
  linkExpiresAt: string | null;
}

export function fetchAdminWalletMissing() {
  return adminFetch<{ walletMissing: AdminWalletMissing[] }>('/wallet-missing');
}

export function sendAdminWalletReminder(nftIssueId: string) {
  return adminSend<{ lastReminderSentAt: string }>('POST', `/wallet-missing/${nftIssueId}/reminder`, undefined);
}

export function deleteAdminWalletReminder(nftIssueId: string) {
  return adminSend<void>('DELETE', `/wallet-missing/${nftIssueId}/reminder`);
}

export function createAdminWalletRegistrationLink(userId: string) {
  return adminSend<{ url: string }>('POST', `/wallet-missing/${userId}/registration-link`, undefined);
}

export function revokeAdminWalletRegistrationLink(userId: string) {
  return adminSend<void>('DELETE', `/wallet-missing/${userId}/registration-link`);
}
