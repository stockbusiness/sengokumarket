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
  couponName: string | null;
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

// 仕様書外の拡張(クーポン機能): この代理店が発行時に選択できるクーポン一覧。
export interface AgencyAvailableCoupon {
  id: string;
  code: string;
  name: string;
  discountType: 'fixed' | 'percentage';
  discountAmount: number | null;
  discountPercentage: number | null;
  expiresAt: string | null;
}

export function fetchAgencyAvailableCoupons() {
  return agencyFetch<{ coupons: AgencyAvailableCoupon[] }>('/coupons/available');
}

export interface CreateAgencyReferralLinkPayload {
  influencer: { id: string } | { new_name: string } | null;
  commission_rate: number | null;
  coupon_id?: string | null;
}

export function createAgencyReferralLink(payload: CreateAgencyReferralLinkPayload) {
  return agencySend<{ referralLink: AgencyReferralLink }>('POST', '/referral-links', payload);
}

export interface AgencyOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  totalAmount: number;
  paymentStatus: string;
  createdAt: string;
  items: { productName: string; variantName: string | null; quantity: number }[];
}

export function fetchAgencyOrders() {
  return agencyFetch<{ orders: AgencyOrder[] }>('/orders');
}
