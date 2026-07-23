// 保守性改善Phase 4: 実装はmodules/checkout/へ分割済み。既存の呼び出し元(routes/checkout.ts・
// 各種テスト)を変更せずに済むよう、このファイルは互換re-exportのバレルとしてのみ残す。
export type { CheckoutItemInput, CreatePendingOrderInput, CreatePendingOrderResult } from '../modules/checkout/domain/checkout.types';
export { validateCreatePendingOrderInput } from '../modules/checkout/domain/checkoutInput';
export { createPendingOrder } from '../modules/checkout/application/createPendingOrder.usecase';
export { cancelOrderReservation } from '../modules/checkout/application/cancelOrderReservation.usecase';
