import type { PaymentStatus } from '@sengoku/contracts';
import { assertStatusTransition } from './statusTransition';

// services/stripeWebhookHandlers.ts・services/bankTransfer.tsの実際の遷移を元に定義した参照用の
// Policy。決済確定はWebhookのみで行う方針(CLAUDE.md)を尊重し、Stripe Webhook・銀行振込確認の
// 処理自体にはこのPolicyを組み込まない(既存の冪等性ガードのみで制御する。指示書11.4
// 「Webhook処理に影響しない」)。将来、決済状態を扱う新しいユースケースを追加する際の
// 参照・単体テスト対象として定義する。
const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: ['paid', 'failed', 'expired'],
  paid: ['refunded'],
  failed: ['refunded'],
  expired: ['refunded'],
  refunded: [],
};

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  assertStatusTransition(
    PAYMENT_TRANSITIONS,
    from,
    to,
    'INVALID_PAYMENT_STATUS_TRANSITION',
    `決済ステータスを${from}から${to}へ変更することはできません`,
  );
}
