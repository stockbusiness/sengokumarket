import { adminFetch, adminSend } from '../../shared/api/adminClient';

// 残課題指示書Stage3・本番安定化指示書Stage11(14.1「Notification Outbox」画面)。
export interface AdminNotificationOutboxEvent {
  id: string;
  eventType: string;
  recipient: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  processedAt: string | null;
  createdAt: string;
}

export function fetchAdminNotificationOutbox(page: number, status?: string) {
  const q = new URLSearchParams({ page: String(page) });
  if (status) q.set('status', status);
  return adminFetch<{ notificationOutboxEvents: AdminNotificationOutboxEvent[]; total: number; page: number; pageSize: number }>(
    `/notification-outbox?${q.toString()}`,
  );
}

export function retryAdminNotification(id: string) {
  return adminSend<{ ok: boolean; status: string }>('POST', `/notification-outbox/${id}/retry`, undefined);
}
