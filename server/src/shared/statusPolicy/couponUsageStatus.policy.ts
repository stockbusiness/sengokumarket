import type { CouponUsageStatus } from '@sengoku/contracts';
import { assertStatusTransition } from './statusTransition';

// services/coupon.tsの実際の遷移(予約時のreserved、決済完了時のused、決済失敗/期限切れ時の
// cancelled/expired、全額返金時のused→cancelled(restoreOnCancel設定時のみ))を元に定義した
// 参照用のPolicy。coupon.ts自体は在庫のreservedStockと同じ考え方で行ロック+検証を行う
// 変更禁止範囲(CLAUDE.md)のため、このPolicyは組み込まない(Domain Unit Testの対象として
// 定義するのみ)。
const COUPON_USAGE_TRANSITIONS: Record<CouponUsageStatus, readonly CouponUsageStatus[]> = {
  reserved: ['used', 'cancelled', 'expired'],
  used: ['cancelled'],
  cancelled: [],
  expired: [],
};

export function assertCouponUsageTransition(from: CouponUsageStatus, to: CouponUsageStatus): void {
  assertStatusTransition(
    COUPON_USAGE_TRANSITIONS,
    from,
    to,
    'INVALID_COUPON_USAGE_STATUS_TRANSITION',
    `クーポン利用ステータスを${from}から${to}へ変更することはできません`,
  );
}
