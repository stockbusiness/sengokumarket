import { adminFetch, adminSend } from '../../shared/api/adminClient';

export interface AdminNotice {
  id: string;
  title: string;
  body: string;
  status: string;
  publishedAt: string | null;
}

export function fetchAdminNotices() {
  return adminFetch<{ notices: AdminNotice[] }>('/notices');
}

export function createAdminNotice(payload: { title: string; body: string }) {
  return adminSend<{ notice: AdminNotice }>('POST', '/notices', payload);
}

export function updateAdminNotice(id: string, payload: { title?: string; body?: string; status?: string }) {
  return adminSend<{ notice: AdminNotice }>('PUT', `/notices/${id}`, payload);
}

export function deleteAdminNotice(id: string) {
  return adminSend<void>('DELETE', `/notices/${id}`);
}
