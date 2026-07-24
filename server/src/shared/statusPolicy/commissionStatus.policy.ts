import { COMMISSION_STATUS_TRANSITIONS, type CommissionStatus } from '@sengoku/contracts';
import { assertStatusTransition } from './statusTransition';

// 仕様書v1.5 5.8「報酬ステータス更新(approved→paidは支払完了後に管理者が手動変更)」に従い、
// paidへはapprovedを必ず経由させる(pendingから直接paidへの変更は許可しない)。
// approved→pendingはCSV出力の一括承認を誤って行った場合の取り消し用に許可する。
// paid(支払済)は変更禁止範囲(CLAUDE.md「支払済み報酬は回収注記を残す」)のため終端状態とする。
// 残課題指示書Stage8: この表自体は@sengoku/contractsを唯一の定義元とし、管理画面UI
// (client/src/components/StatusSelect.tsx)も同じ表を参照する。

export function assertCommissionTransition(from: CommissionStatus, to: CommissionStatus): void {
  assertStatusTransition(
    COMMISSION_STATUS_TRANSITIONS,
    from,
    to,
    'INVALID_COMMISSION_STATUS_TRANSITION',
    `報酬ステータスを${from}から${to}へ変更することはできません`,
  );
}
