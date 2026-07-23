import { adminFetch, adminSend } from '../../shared/api/adminClient';
import type { AdminRole } from '@sengoku/contracts';

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  createdAt: string;
}

export function fetchAdminUsers() {
  return adminFetch<{ adminUsers: AdminUser[] }>('/admin-users');
}

export function createAdminUser(payload: { name: string; email: string; role: AdminUser['role'] }) {
  return adminSend<{ adminUser: AdminUser }>('POST', '/admin-users', payload);
}

export function updateAdminUserRole(id: string, role: AdminUser['role']) {
  return adminSend<{ adminUser: AdminUser }>('PUT', `/admin-users/${id}/role`, { role });
}

export function resendAdminUserSetupEmail(id: string) {
  return adminSend<{ success: true }>('POST', `/admin-users/${id}/resend-setup-email`);
}

export function deleteAdminUser(id: string) {
  return adminSend<{ success: true }>('DELETE', `/admin-users/${id}`);
}
