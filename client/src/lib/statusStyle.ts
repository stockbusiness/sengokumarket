export type StatusVariant = 'success' | 'neutral' | 'warning' | 'muted';

// 管理画面全体で使うステータス→ピル配色の対応(仕様書外のUI拡張)。
// 新しい色は増やさず、既存のsuccess/danger/mutedトークンのみを使う。
const STATUS_VARIANTS: Record<string, StatusVariant> = {
  paid: 'success',
  completed: 'success',
  issued: 'success',
  approved: 'success',
  active: 'success',
  published: 'success',
  ready_to_issue: 'neutral',
  wallet_required: 'neutral',
  pending: 'neutral',
  draft: 'neutral',
  failed: 'warning',
  refunded: 'warning',
  expired: 'warning',
  cancelled: 'muted',
  inactive: 'muted',
};

export function statusVariant(status: string): StatusVariant {
  return STATUS_VARIANTS[status] ?? 'neutral';
}
