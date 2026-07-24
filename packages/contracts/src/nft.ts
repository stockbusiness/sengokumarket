export const NFT_ISSUE_STATUSES = [
  'wallet_required',
  'ready_to_issue',
  'processing',
  'issued',
  'failed',
  'cancelled',
] as const;
export type NftIssueStatus = (typeof NFT_ISSUE_STATUSES)[number];

// 仕様書外の拡張(残課題指示書Stage8): 状態遷移Policyと管理画面UIの両方が同じ表を参照する
// 唯一の定義元(server/src/shared/statusPolicy/nftIssueStatus.policy.tsからimportされる)。
export const NFT_ISSUE_STATUS_TRANSITIONS: Record<NftIssueStatus, readonly NftIssueStatus[]> = {
  wallet_required: ['ready_to_issue', 'issued', 'cancelled'],
  ready_to_issue: ['processing', 'issued', 'cancelled'],
  processing: ['issued', 'ready_to_issue', 'failed'],
  issued: [],
  failed: ['ready_to_issue', 'issued', 'cancelled'],
  cancelled: [],
};
