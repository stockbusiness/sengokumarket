import { adminFetch, adminSend } from '../../shared/api/adminClient';

export interface AdminNftIssue {
  id: string;
  orderNumber: string;
  customerName: string;
  productName: string;
  variantName: string | null;
  walletAddress: string | null;
  status: string;
  tokenId: string | null;
  transactionHash: string | null;
  issuedAt: string | null;
  adminNote: string | null;
  // 仕様書外の拡張(NFT自動発行): 外部Mint API連携の状態表示用。
  attemptCount: number;
  lastError: string | null;
  submittedAt: string | null;
  providerRequestId: string | null;
  nextAttemptAt: string | null;
}

export function fetchAdminNftIssues(page: number, status?: string) {
  const q = new URLSearchParams({ page: String(page) });
  if (status) q.set('status', status);
  return adminFetch<{ nftIssues: AdminNftIssue[]; total: number; page: number; pageSize: number }>(`/nft-issues?${q.toString()}`);
}

export interface UpdateNftIssueRequest {
  status?: string;
  tokenId?: string;
  transactionHash?: string;
  adminNote?: string;
}

export function updateAdminNftIssue(id: string, payload: UpdateNftIssueRequest) {
  return adminSend<{ nftIssue: AdminNftIssue }>('PUT', `/nft-issues/${id}`, payload);
}

export function retryAdminNftIssue(id: string) {
  return adminSend<{ nftIssue: AdminNftIssue }>('POST', `/nft-issues/${id}/retry`, undefined);
}

export function holdAdminNftIssue(id: string) {
  return adminSend<{ nftIssue: AdminNftIssue }>('POST', `/nft-issues/${id}/hold`, undefined);
}
