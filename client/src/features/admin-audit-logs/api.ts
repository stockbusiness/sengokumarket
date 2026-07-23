import { adminFetch } from '../../shared/api/adminClient';

export interface AdminAuditLogEntry {
  id: string;
  actorEmail: string;
  actorRole: string;
  method: string;
  path: string;
  requestBody: unknown;
  statusCode: number;
  createdAt: string;
}

export function fetchAdminAuditLogs(page: number) {
  return adminFetch<{ logs: AdminAuditLogEntry[]; total: number; page: number; pageSize: number }>(`/audit-logs?page=${page}`);
}
