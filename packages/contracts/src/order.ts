// orders.order_status(仕様書v1.5)。orders.payment_statusとは異なる値集合を持つため
// 混同しないこと(paymentStatusはpayment.tsで定義する。例: paymentStatusの'failed'/'expired'は
// orderStatus側には存在せず、その間orderStatusは'pending'のまま維持される)。
export const ORDER_STATUSES = ['pending', 'paid', 'cancelled', 'refunded'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const COMMISSION_STATUSES = ['pending', 'approved', 'paid', 'cancelled'] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

// 仕様書外の拡張(クーポン機能): coupon_usages.status。
export const COUPON_USAGE_STATUSES = ['reserved', 'used', 'cancelled', 'expired'] as const;
export type CouponUsageStatus = (typeof COUPON_USAGE_STATUSES)[number];
