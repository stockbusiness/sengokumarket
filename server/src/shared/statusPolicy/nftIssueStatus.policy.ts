import { NFT_ISSUE_STATUS_TRANSITIONS, type NftIssueStatus } from '@sengoku/contracts';
import { assertStatusTransition } from './statusTransition';

// CLAUDE.md「nft_issues」章: wallet_required → ready_to_issue → processing → issued
// (失敗時はready_to_issueに戻って再試行、最大試行回数超過でfailed。返金・キャンセルでcancelled。
// processing中の行は全額返金でもcancelledにせず注記のみ追加)を基本の状態機械とする。
// 加えて、管理画面からの手動記録(自動発行を経由せずtoken_id/transaction_hashを直接入力して
// issuedにする運用。admin/nftIssues.test.ts参照)のため、issued以外の各状態からissuedへの
// 直接遷移も許可する。issuedは一度発行すると取り消せないため終端状態とする。
// 残課題指示書Stage8: この表自体は@sengoku/contractsを唯一の定義元とし、管理画面UI
// (client/src/components/StatusSelect.tsx)も同じ表を参照する。

export function assertNftIssueTransition(from: NftIssueStatus, to: NftIssueStatus): void {
  assertStatusTransition(
    NFT_ISSUE_STATUS_TRANSITIONS,
    from,
    to,
    'INVALID_NFT_ISSUE_STATUS_TRANSITION',
    `NFT発行ステータスを${from}から${to}へ変更することはできません`,
  );
}
