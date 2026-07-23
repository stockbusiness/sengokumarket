import { adminFetch, adminSend } from '../../shared/api/adminClient';

export interface AdminReferralLink {
  id: string;
  code: string;
  url: string;
  agencyName: string | null;
  influencerName: string | null;
  resolvedCommissionRate: number;
  status: string;
  createdAt: string;
}

export function fetchAdminReferralLinks() {
  return adminFetch<{ referralLinks: AdminReferralLink[] }>('/referral-links');
}

export interface CreateReferralLinkRequest {
  agency: { id: string } | { new_name: string; default_commission_rate?: number };
  influencer: { id: string } | { new_name: string } | null;
  commission_rate: number | null;
}

export function createAdminReferralLink(payload: CreateReferralLinkRequest) {
  return adminSend<{ referralLink: AdminReferralLink }>('POST', '/referral-links', payload);
}

export function updateAdminReferralLinkStatus(id: string, status: 'active' | 'inactive') {
  return adminSend<{ referralLink: { id: string; status: string } }>('PUT', `/referral-links/${id}/status`, { status });
}

export interface AdminReferralSummaryRow {
  orderCount: number;
  paidCount: number;
  salesAmount: number;
  commissionAmount: number;
}
export interface AdminReferralSummary {
  byAgency: (AdminReferralSummaryRow & { agencyId: string; agencyName: string })[];
  byInfluencer: (AdminReferralSummaryRow & { influencerId: string; influencerName: string; agencyName: string | null })[];
}

export function fetchAdminReferralsSummary() {
  return adminFetch<AdminReferralSummary>('/referrals/summary');
}

export interface AdminCommission {
  id: string;
  orderNumber: string;
  customerName: string;
  agencyName: string | null;
  influencerName: string | null;
  referralCode: string | null;
  baseAmount: number;
  commissionRate: number;
  commissionAmount: number;
  status: string;
  approvedAt: string | null;
  paidAt: string | null;
  adminNote: string | null;
}

export function fetchAdminCommissions(page: number, status?: string) {
  const q = new URLSearchParams({ page: String(page) });
  if (status) q.set('status', status);
  return adminFetch<{ commissions: AdminCommission[]; total: number; page: number; pageSize: number }>(`/referrals/commissions?${q.toString()}`);
}

export function updateAdminCommission(id: string, payload: { status?: string; adminNote?: string }) {
  return adminSend<{ commission: AdminCommission }>('PUT', `/referrals/commissions/${id}`, payload);
}

export function buildReferralExportCsvUrl(params: { from: string; to: string; status: string; markApproved: boolean }) {
  const q = new URLSearchParams({
    from: params.from,
    to: params.to,
    status: params.status,
    mark_approved: String(params.markApproved),
  });
  return `/api/admin/referrals/export.csv?${q.toString()}`;
}
