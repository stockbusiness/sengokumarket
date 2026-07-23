import type { StripeEventStatus } from '@sengoku/contracts';
import { assertStatusTransition } from './statusTransition';

// services/stripeEventInbox.tsの実際の遷移(processingへのclaim・成功・再試行可能/再試行不可への
// 失敗・failed_*からprocessingへの手動/自動再試行)を元に定義した参照用のPolicy。
// stripeEventInbox.ts自体は条件付きUPDATE(WHERE status=...)によるアトミックなclaimで
// 冪等性を担保しており(指示書3.1・変更禁止範囲)、このPolicyは組み込まない
// (Prisma・Expressに依存しないDomain Unit Testの対象として定義するのみ)。
const STRIPE_EVENT_TRANSITIONS: Record<StripeEventStatus, readonly StripeEventStatus[]> = {
  processing: ['succeeded', 'failed_retryable', 'failed_terminal'],
  succeeded: [],
  failed_retryable: ['processing'],
  failed_terminal: ['processing'],
};

export function assertStripeEventTransition(from: StripeEventStatus, to: StripeEventStatus): void {
  assertStatusTransition(
    STRIPE_EVENT_TRANSITIONS,
    from,
    to,
    'INVALID_STRIPE_EVENT_STATUS_TRANSITION',
    `Stripeイベントステータスを${from}から${to}へ変更することはできません`,
  );
}
