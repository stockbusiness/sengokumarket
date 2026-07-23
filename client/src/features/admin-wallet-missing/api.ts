import { adminFetch, adminSend } from '../../shared/api/adminClient';

export interface AdminWalletMissing {
  id: string;
  customerName: string;
  customerEmail: string;
  orderNumber: string;
  productName: string;
  purchasedAt: string;
  lastReminderSentAt: string | null;
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
