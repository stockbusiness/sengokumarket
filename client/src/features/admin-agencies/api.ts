import { adminFetch, adminSend } from '../../shared/api/adminClient';

export function fetchAdminAgencies() {
  return adminFetch<{ agencies: { id: string; name: string }[] }>('/agencies');
}

export interface AdminAgencyDetail {
  id: string;
  name: string;
  code: string;
  externalId: string | null;
  parentAgencyName: string | null;
  status: string;
  defaultCommissionRate: number;
  loginEmail: string | null;
}

export function fetchAdminAgenciesDetail() {
  return adminFetch<{ agencies: AdminAgencyDetail[] }>('/agencies/detail');
}

export function syncAgenciesFromExternalSystem() {
  return adminSend<{ agenciesSynced: number; applicationsApproved: number }>('POST', '/agencies/sync-external');
}

export function fetchAdminInfluencers(agencyId?: string) {
  return adminFetch<{ influencers: { id: string; name: string }[] }>(
    `/influencers${agencyId ? `?agency_id=${agencyId}` : ''}`,
  );
}
