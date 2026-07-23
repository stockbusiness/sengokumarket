// orders.payment_status。orders.order_status(order.ts参照)とは異なる値集合を持つ。
export const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'refunded', 'expired'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

// 仕様書外の拡張(Stripe Webhook Inbox方式): stripe_events.status。
export const STRIPE_EVENT_STATUSES = ['processing', 'succeeded', 'failed_retryable', 'failed_terminal'] as const;
export type StripeEventStatus = (typeof STRIPE_EVENT_STATUSES)[number];
