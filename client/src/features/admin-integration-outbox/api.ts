import { adminFetch, adminSend } from '../../shared/api/adminClient';

// 本番安定化指示書Stage11(14.1「Integration Outbox」・「Integration Attempts」画面)。
export interface AdminIntegrationOutboxEvent {
  id: string;
  eventId: string;
  eventType: string;
  destinationSystemKey: string;
  correlationId: string | null;
  status: string;
  attemptCount: number;
  lastError: string | null;
  blockedReason: string | null;
  nextAttemptAt: string | null;
  processedAt: string | null;
  createdAt: string;
}

export function fetchAdminIntegrationOutbox(page: number, status?: string) {
  const q = new URLSearchParams({ page: String(page) });
  if (status) q.set('status', status);
  return adminFetch<{ outboxEvents: AdminIntegrationOutboxEvent[]; total: number; page: number; pageSize: number }>(
    `/integration-outbox?${q.toString()}`,
  );
}

export function retryAdminIntegrationOutboxEvent(id: string) {
  return adminSend<{ ok: boolean; status: string }>('POST', `/integration-outbox/${id}/retry`, undefined);
}

export interface AdminIntegrationEventAttempt {
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

export function fetchAdminIntegrationOutboxAttempts(id: string) {
  return adminFetch<{ attempts: AdminIntegrationEventAttempt[] }>(`/integration-outbox/${id}/attempts`);
}
