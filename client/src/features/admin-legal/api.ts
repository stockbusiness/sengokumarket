import { adminFetch, adminSend } from '../../shared/api/adminClient';

export interface AdminLegalDocument {
  slug: string;
  title: string;
  body: string;
  updatedAt: string;
}

export function fetchAdminLegalDocuments() {
  return adminFetch<{ documents: AdminLegalDocument[] }>('/legal');
}

export function updateAdminLegalDocument(slug: string, payload: { title: string; body: string }) {
  return adminSend<{ document: AdminLegalDocument }>('PUT', `/legal/${slug}`, payload);
}
