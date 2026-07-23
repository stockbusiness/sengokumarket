import { adminFetch, adminSend } from '../../shared/api/adminClient';

export interface AdminOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  totalAmount: number;
  paymentStatus: string;
  orderStatus: string;
  paymentMethod: string;
  paidAt: string | null;
  referralCode: string | null;
  agencyName: string | null;
  referrerName: string | null;
  commissionAmount: number;
  commissionStatus: string;
  adminNote: string | null;
  createdAt: string;
  // 仕様書外の拡張: 代理店階層の紐付け記録(報酬計算には使わない)と説明責任者。
  referralHierarchy: { id: string; name: string; code: string; depth: number }[] | null;
  explainerName: string | null;
  explainerMatched: boolean;
}

export function fetchAdminOrders() {
  return adminFetch<{ orders: AdminOrder[] }>('/orders');
}

export interface UpdateOrderRequest {
  orderStatus?: string;
  adminNote?: string;
  explainerName?: string;
}

export function updateAdminOrder(id: string, payload: UpdateOrderRequest) {
  return adminSend<{ order: AdminOrder }>('PUT', `/orders/${id}`, payload);
}

export function buildOrdersExportCsvUrl() {
  return '/api/admin/orders/export.csv';
}

export function confirmBankTransferPayment(id: string) {
  return adminSend<{ order: AdminOrder }>('POST', `/orders/${id}/confirm-bank-transfer`, undefined);
}
