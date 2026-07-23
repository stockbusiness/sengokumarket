export const NFT_ISSUE_STATUSES = [
  'wallet_required',
  'ready_to_issue',
  'processing',
  'issued',
  'failed',
  'cancelled',
] as const;
export type NftIssueStatus = (typeof NFT_ISSUE_STATUSES)[number];
