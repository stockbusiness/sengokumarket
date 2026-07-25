// 仕様書外の拡張(千ノ国全体連携): integration_outbox_events.status。
// 残課題指示書Stage6: 必須ID未解決のため送信を保留する'blocked'を追加。
export const INTEGRATION_OUTBOX_STATUSES = ['pending', 'processing', 'succeeded', 'failed', 'dead', 'blocked'] as const;
export type IntegrationOutboxStatus = (typeof INTEGRATION_OUTBOX_STATUSES)[number];

// 残課題指示書Stage3: notification_outbox_events.status。
export const NOTIFICATION_OUTBOX_STATUSES = ['pending', 'processing', 'succeeded', 'failed', 'dead'] as const;
export type NotificationOutboxStatus = (typeof NOTIFICATION_OUTBOX_STATUSES)[number];

// 本番安定化指示書Stage5: order_linking_jobs.status。'blocked'は依存(common_user_id解決・
// referral capture)待ちでattempt_countを消費しない状態、'skipped'は管理者が処理対象から
// 外した状態(succeeded/failed/deadとは区別する)。
export const ORDER_LINKING_JOB_STATUSES = ['pending', 'processing', 'blocked', 'succeeded', 'failed', 'dead', 'skipped'] as const;
export type OrderLinkingJobStatus = (typeof ORDER_LINKING_JOB_STATUSES)[number];

// 本番安定化指示書Stage6: product_integration_rules.entitlement_target_system_key。
export const ENTITLEMENT_TARGET_SYSTEM_KEYS = ['sengoku-passport', 'ove-wallet', 'ai-art-school'] as const;
export type EntitlementTargetSystemKey = (typeof ENTITLEMENT_TARGET_SYSTEM_KEYS)[number];

// 本番安定化指示書Stage6(9.3・9.4): OVE Walletへ渡すポイント量の計算方法。商品の購入数量を
// そのままポイント数にしないための設定。fixed_per_order/fixed_totalは現状同じ扱い(数量に
// 比例させず、reward_amount_per_unitをそのまま固定額として使う)だが、将来の計算方式追加に
// 備えて意味を分けている。
export const REWARD_CALCULATION_MODES = ['fixed_per_order', 'per_quantity', 'fixed_total'] as const;
export type RewardCalculationMode = (typeof REWARD_CALCULATION_MODES)[number];
