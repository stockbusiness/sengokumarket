import { ApiError } from './api';

async function agencyFetch<T>(path: string): Promise<T> {
  const res = await fetch(`/api/agency${path}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code, body?.error?.message ?? `リクエストに失敗しました(${res.status})`);
  }
  return body;
}

async function agencySend<T>(method: 'POST' | 'PUT', path: string, payload?: unknown): Promise<T> {
  const res = await fetch(`/api/agency${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error?.code, body?.error?.message ?? `リクエストに失敗しました(${res.status})`);
  }
  return body;
}

export interface AgencyReferralLink {
  id: string;
  code: string;
  url: string;
  influencerName: string | null;
  resolvedCommissionRate: number;
  status: string;
  createdAt: string;
}

export function fetchAgencyReferralLinks() {
  return agencyFetch<{ referralLinks: AgencyReferralLink[] }>('/referral-links');
}

export function fetchAgencyInfluencers() {
  return agencyFetch<{ influencers: { id: string; name: string }[] }>('/influencers');
}

export function fetchAgencyLandingOptions() {
  return agencyFetch<{ options: { path: string; label: string }[] }>('/referral-links/landing-options');
}

export interface CreateAgencyReferralLinkPayload {
  influencer: { id: string } | { new_name: string } | null;
  commission_rate: number | null;
  landing_path: string;
}

export function createAgencyReferralLink(payload: CreateAgencyReferralLinkPayload) {
  return agencySend<{ referralLink: AgencyReferralLink }>('POST', '/referral-links', payload);
}
