import { adminFetch, adminSend } from '../../shared/api/adminClient';

// 購入後代理店システム連携実装指示書 6.13章「管理画面」。
export interface AdminPurchaseProvisioningJob {
  id: string;
  orderId: string;
  commonUserId: string | null;
  action: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  blockedReason: string | null;
  nextAttemptAt: string | null;
  processedAt: string | null;
  createdAt: string;
  order: {
    orderNumber: string;
    customerEmail: string;
    agencyAccountType: string | null;
    agencyLoginUrl: string | null;
  } | null;
}

export function fetchAdminPurchaseProvisioningJobs(page: number, status?: string, search?: string) {
  const q = new URLSearchParams({ page: String(page) });
  if (status) q.set('status', status);
  if (search) q.set('search', search);
  return adminFetch<{ jobs: AdminPurchaseProvisioningJob[]; total: number; page: number; pageSize: number }>(
    `/purchase-provisioning-jobs?${q.toString()}`,
  );
}

export function retryAdminPurchaseProvisioningJob(id: string) {
  return adminSend<{ ok: boolean; status: string }>('POST', `/purchase-provisioning-jobs/${id}/retry`, undefined);
}

export function skipAdminPurchaseProvisioningJob(id: string) {
  return adminSend<{ ok: boolean; status: string }>('POST', `/purchase-provisioning-jobs/${id}/skip`, undefined);
}
