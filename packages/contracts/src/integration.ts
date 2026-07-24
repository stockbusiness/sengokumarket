// 仕様書外の拡張(千ノ国全体連携): integration_outbox_events.status。
export const INTEGRATION_OUTBOX_STATUSES = ['pending', 'processing', 'succeeded', 'failed', 'dead'] as const;
export type IntegrationOutboxStatus = (typeof INTEGRATION_OUTBOX_STATUSES)[number];

// 残課題指示書Stage3: notification_outbox_events.status。
export const NOTIFICATION_OUTBOX_STATUSES = ['pending', 'processing', 'succeeded', 'failed', 'dead'] as const;
export type NotificationOutboxStatus = (typeof NOTIFICATION_OUTBOX_STATUSES)[number];
