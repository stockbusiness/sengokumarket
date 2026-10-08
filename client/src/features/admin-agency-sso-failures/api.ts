import { adminFetch } from '../../shared/api/adminClient';

// 仕様書外の拡張(2026-10・緊急障害対応): 代理店SSOログイン失敗の一覧。
export interface AdminAgencySsoFailure {
  id: string;
  errorCode: string;
  detail: {
    sub?: string | null;
    iss?: string | null;
    agencyNameClaim?: string | null;
    hasActorEmailClaim?: boolean;
    hasContactEmailClaim?: boolean;
  } | null;
  createdAt: string;
}

export function fetchAdminAgencySsoFailures(page: number) {
  return adminFetch<{ failures: AdminAgencySsoFailure[]; total: number; page: number; pageSize: number }>(
    `/agency-sso-failures?page=${page}`,
  );
}
