// orders.order_status(仕様書v1.5)。orders.payment_statusとは異なる値集合を持つため
// 混同しないこと(paymentStatusはpayment.tsで定義する。例: paymentStatusの'failed'/'expired'は
// orderStatus側には存在せず、その間orderStatusは'pending'のまま維持される)。
export const ORDER_STATUSES = ['pending', 'paid', 'cancelled', 'refunded'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// 仕様書外の拡張(残課題指示書Stage8): 状態遷移Policyと管理画面UIの両方が同じ表を参照する
// 唯一の定義元。サーバー側(shared/statusPolicy/orderStatus.policy.ts)はここからimportし、
// クライアント側は選択肢の絞り込み(現在状態+許可遷移のみ表示)に使う。
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['paid', 'cancelled'],
  paid: ['refunded', 'cancelled'],
  cancelled: [],
  refunded: [],
};

export const COMMISSION_STATUSES = ['pending', 'approved', 'paid', 'cancelled'] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

export const COMMISSION_STATUS_TRANSITIONS: Record<CommissionStatus, readonly CommissionStatus[]> = {
  pending: ['approved', 'cancelled'],
  approved: ['paid', 'cancelled', 'pending'],
  paid: [],
  cancelled: [],
};

// 仕様書外の拡張(クーポン機能): coupon_usages.status。
export const COUPON_USAGE_STATUSES = ['reserved', 'used', 'cancelled', 'expired'] as const;
export type CouponUsageStatus = (typeof COUPON_USAGE_STATUSES)[number];
