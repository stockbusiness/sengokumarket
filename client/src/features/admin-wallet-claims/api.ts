import { adminFetch, adminSend } from '../../shared/api/adminClient';

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)19章「管理画面」。
export interface AdminWalletClaim {
  id: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  status: string;
  expiresAt: string;
  claimedAt: string | null;
  deliveredAt: string | null;
  revokedAt: string | null;
  manualReviewRequiredAt: string | null;
  commonUserId: string | null;
  oveAccountId: string | null;
  lastError: string | null;
  deliveryCount: number;
  deliveredCount: number;
  createdAt: string;
}

export interface AdminWalletClaimDeliverySummary {
  id: string;
  nftIssueId: string;
  entitlementId: string;
  productName: string;
  serialNumber: number | null;
  commonUserId: string;
  oveAccountId: string;
  status: string;
  deliveredAt: string | null;
  revokedAt: string | null;
  lastError: string | null;
  outboxEventId: string | null;
}

export interface AdminWalletClaimAuditLog {
  id: string;
  eventType: string;
  detail: unknown;
  createdAt: string;
}

export interface AdminWalletClaimDetail extends AdminWalletClaim {
  customerEmail: string;
  updatedAt: string;
  deliveries: AdminWalletClaimDeliverySummary[];
  auditLogs: AdminWalletClaimAuditLog[];
}

export interface WalletClaimSearchFilters {
  orderNumber?: string;
  status?: string;
  commonUserId?: string;
  oveAccountId?: string;
}

export function fetchAdminWalletClaims(page: number, filters: WalletClaimSearchFilters = {}) {
  const q = new URLSearchParams({ page: String(page) });
  if (filters.orderNumber) q.set('orderNumber', filters.orderNumber);
  if (filters.status) q.set('status', filters.status);
  if (filters.commonUserId) q.set('commonUserId', filters.commonUserId);
  if (filters.oveAccountId) q.set('oveAccountId', filters.oveAccountId);
  return adminFetch<{ walletClaims: AdminWalletClaim[]; total: number; page: number; pageSize: number }>(`/wallet-claims?${q.toString()}`);
}

export function fetchAdminWalletClaim(id: string) {
  return adminFetch<{ walletClaim: AdminWalletClaimDetail }>(`/wallet-claims/${id}`);
}

// 生Tokenは返らない(サーバー側で登録メールアドレスへ直接送付される)。
export function reissueAdminWalletClaim(id: string) {
  return adminSend<{ ok: boolean; sentTo: string }>('POST', `/wallet-claims/${id}/reissue`, undefined);
}
