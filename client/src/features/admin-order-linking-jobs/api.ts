import { adminFetch, adminSend } from '../../shared/api/adminClient';

// 本番安定化指示書Stage5(8.6)・Stage11(14.1「Order Linking Jobs」「External Identity conflicts」画面)。
export interface AdminOrderLinkingJob {
  id: string;
  jobType: string;
  userId: string | null;
  orderId: string | null;
  status: string;
  attemptCount: number;
  lastError: string | null;
  blockedReason: string | null;
  nextAttemptAt: string | null;
  processedAt: string | null;
  createdAt: string;
}

export function fetchAdminOrderLinkingJobs(page: number, status?: string, blockedReason?: string) {
  const q = new URLSearchParams({ page: String(page) });
  if (status) q.set('status', status);
  if (blockedReason) q.set('blockedReason', blockedReason);
  return adminFetch<{ jobs: AdminOrderLinkingJob[]; total: number; page: number; pageSize: number }>(
    `/order-linking-jobs?${q.toString()}`,
  );
}

export function retryAdminOrderLinkingJob(id: string) {
  return adminSend<{ ok: boolean; status: string }>('POST', `/order-linking-jobs/${id}/retry`, undefined);
}

export function skipAdminOrderLinkingJob(id: string) {
  return adminSend<{ ok: boolean; status: string }>('POST', `/order-linking-jobs/${id}/skip`, undefined);
}
