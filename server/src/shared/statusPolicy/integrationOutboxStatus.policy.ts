import type { IntegrationOutboxStatus } from '@sengoku/contracts';
import { assertStatusTransition } from './statusTransition';

// services/integrationOutboxDispatcher.tsの実際の遷移(pending/blocked⇄processing、processingからの
// succeeded/dead/blocked、staleなprocessingのpendingへの復帰)を元に定義した参照用のPolicy。
// 現時点で管理画面からの手動ステータス変更エンドポイントは存在せず(読み取り専用)、
// dispatcher自体も条件付きUPDATEでアトミックにclaimしているため、このPolicyはまだ
// どこにも組み込まない(将来、手動再送信等の管理操作を追加する際の参照として定義する)。
// 'failed'は契約上の型には存在するが、現在のdispatcher実装では到達しない
// (最大試行回数超過時は'dead'を使う)。将来の利用に備え終端状態として定義しておく。
// 'blocked'(残課題指示書Stage6): 必須ID未解決のため送信を保留した状態。pendingと同様に
// dispatcherの毎回のclaim対象になり、ID解決後は自動的にprocessingへ戻って再評価される。
const INTEGRATION_OUTBOX_TRANSITIONS: Record<IntegrationOutboxStatus, readonly IntegrationOutboxStatus[]> = {
  pending: ['processing'],
  processing: ['succeeded', 'dead', 'pending', 'failed', 'blocked'],
  succeeded: [],
  failed: [],
  dead: [],
  blocked: ['processing'],
};

export function assertIntegrationOutboxTransition(from: IntegrationOutboxStatus, to: IntegrationOutboxStatus): void {
  assertStatusTransition(
    INTEGRATION_OUTBOX_TRANSITIONS,
    from,
    to,
    'INVALID_INTEGRATION_OUTBOX_STATUS_TRANSITION',
    `Outboxステータスを${from}から${to}へ変更することはできません`,
  );
}
