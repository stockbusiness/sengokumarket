import { ORDER_STATUS_TRANSITIONS, type OrderStatus } from '@sengoku/contracts';
import { assertStatusTransition } from './statusTransition';

// 実際のコード(checkout作成時のpending、Stripe Webhook/銀行振込確認のpaid、全額返金の
// refunded、管理画面での手動cancelled)を調査して定めた遷移表。paid→cancelledは
// 「返品対応済み」等、Stripe返金を伴わない管理画面での手動キャンセルとして実際に使われている
// (admin/orders.test.ts参照)ため許可する。refunded/cancelledは終端状態とする。
// 残課題指示書Stage8: この表自体は@sengoku/contractsを唯一の定義元とし、管理画面UI
// (client/src/components/StatusSelect.tsx)も同じ表を参照する。

export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  assertStatusTransition(
    ORDER_STATUS_TRANSITIONS,
    from,
    to,
    'INVALID_ORDER_STATUS_TRANSITION',
    `注文ステータスを${from}から${to}へ変更することはできません`,
  );
}
