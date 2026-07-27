import { adminFetch, adminSend } from '../../shared/api/adminClient';

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)19章「管理画面」。
export interface AdminCollectibleDelivery {
  id: string;
  orderNumber: string;
  walletClaimId: string;
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
  createdAt: string;
}

export interface AdminCollectibleDeliveryAttempt {
  id: string;
  attemptNumber: number;
  startedAt: string;
  finishedAt: string | null;
  httpStatus: number | null;
  result: string;
  error: string | null;
  destinationUrl: string | null;
  responseBodyExcerpt: string | null;
}

export interface AdminCollectibleDeliveryDetail extends AdminCollectibleDelivery {
  nftIssueStatus: string;
  outboxEventStatus: string | null;
  updatedAt: string;
  attempts: AdminCollectibleDeliveryAttempt[];
}

export interface CollectibleDeliverySearchFilters {
  orderNumber?: string;
  nftIssueId?: string;
  entitlementId?: string;
  status?: string;
  commonUserId?: string;
  oveAccountId?: string;
}

export function fetchAdminCollectibleDeliveries(page: number, filters: CollectibleDeliverySearchFilters = {}) {
  const q = new URLSearchParams({ page: String(page) });
  if (filters.orderNumber) q.set('orderNumber', filters.orderNumber);
  if (filters.nftIssueId) q.set('nftIssueId', filters.nftIssueId);
  if (filters.entitlementId) q.set('entitlementId', filters.entitlementId);
  if (filters.status) q.set('status', filters.status);
  if (filters.commonUserId) q.set('commonUserId', filters.commonUserId);
  if (filters.oveAccountId) q.set('oveAccountId', filters.oveAccountId);
  return adminFetch<{ collectibleDeliveries: AdminCollectibleDelivery[]; total: number; page: number; pageSize: number }>(
    `/collectible-deliveries?${q.toString()}`,
  );
}

export function fetchAdminCollectibleDelivery(id: string) {
  return adminFetch<{ collectibleDelivery: AdminCollectibleDeliveryDetail }>(`/collectible-deliveries/${id}`);
}

export function retryAdminCollectibleDelivery(id: string) {
  return adminSend<{ ok: boolean; status: string }>('POST', `/collectible-deliveries/${id}/retry`, undefined);
}
