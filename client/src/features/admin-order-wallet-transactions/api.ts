import { adminFetch } from '../../shared/api/adminClient';

// 本番安定化指示書Stage10(13章)・Stage11(14.1「Wallet Transactions」画面)。
export interface AdminOrderWalletTransaction {
  id: string;
  orderId: string;
  orderItemId: string;
  outboxEventId: string;
  productIntegrationRuleId: string | null;
  commonUserId: string | null;
  transactionType: string;
  amount: number;
  rewardRuleId: string | null;
  walletTransactionId: string | null;
  originalWalletTransactionId: string | null;
  status: string;
  createdAt: string;
}

export function fetchAdminOrderWalletTransactions(page: number, filters?: { orderId?: string; orderItemId?: string; commonUserId?: string }) {
  const q = new URLSearchParams({ page: String(page) });
  if (filters?.orderId) q.set('orderId', filters.orderId);
  if (filters?.orderItemId) q.set('orderItemId', filters.orderItemId);
  if (filters?.commonUserId) q.set('commonUserId', filters.commonUserId);
  return adminFetch<{ transactions: AdminOrderWalletTransaction[]; total: number; page: number; pageSize: number }>(
    `/order-wallet-transactions?${q.toString()}`,
  );
}
