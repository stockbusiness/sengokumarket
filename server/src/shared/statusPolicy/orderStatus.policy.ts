import type { OrderStatus } from '@sengoku/contracts';
import { assertStatusTransition } from './statusTransition';

// 実際のコード(checkout作成時のpending、Stripe Webhook/銀行振込確認のpaid、全額返金の
// refunded、管理画面での手動cancelled)を調査して定めた遷移表。paid→cancelledは
// 「返品対応済み」等、Stripe返金を伴わない管理画面での手動キャンセルとして実際に使われている
// (admin/orders.test.ts参照)ため許可する。refunded/cancelledは終端状態とする。
const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['paid', 'cancelled'],
  paid: ['refunded', 'cancelled'],
  cancelled: [],
  refunded: [],
};

export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  assertStatusTransition(ORDER_TRANSITIONS, from, to, 'INVALID_ORDER_STATUS_TRANSITION', `注文ステータスを${from}から${to}へ変更することはできません`);
}
