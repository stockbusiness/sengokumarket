import { adminFetch } from '../../shared/api/adminClient';

export interface AdminDashboard {
  totalSales: number;
  orderCount: number;
  paidCount: number;
  nftPendingCount: number;
  walletMissingCount: number;
  stockByVariant: { productName: string; variantName: string; stock: number; reservedStock: number; availableStock: number }[];
  referralSales: number;
  agencyTop5: { agencyId: string; agencyName: string; totalSales: number }[];
  pendingCommissionTotal: number;
  alerts: { partialRefundCount: number; commissionRecoveryCount: number };
}

export function fetchAdminDashboard() {
  return adminFetch<AdminDashboard>('/dashboard');
}

export interface SalesTrendMonth {
  month: string;
  totalSales: number;
  orderCount: number;
}

export function fetchAdminSalesTrend(months = 6) {
  return adminFetch<{ trend: SalesTrendMonth[] }>(`/dashboard/sales-trend?months=${months}`);
}
