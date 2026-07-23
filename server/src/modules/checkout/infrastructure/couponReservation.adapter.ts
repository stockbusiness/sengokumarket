import type { Prisma } from '@prisma/client';
import { cancelCouponUsage, reserveCouponUsage } from '../../../services/coupon';
import type { CouponEligibilityItem, ReserveCouponUsageResult } from '../../../services/coupon';

type Tx = Prisma.TransactionClient;

export interface CouponReservationRequest {
  code: string;
  userId: string;
  agencyId: string | null;
  items: CouponEligibilityItem[];
  orderId: string;
}

// クーポンの検証・在庫的な予約ロジック自体は既存のservices/coupon.tsが正であり、変更しない
// (指示書9.3「既存coupon.tsをAdapterとして呼ぶ」)。Checkoutモジュールからは、この薄い
// Adapter越しにのみ呼び出すことで、将来クーポン以外の割引施策を追加する場合の差し替え口とする。
export function reserveCoupon(tx: Tx, input: CouponReservationRequest): Promise<ReserveCouponUsageResult> {
  return reserveCouponUsage(tx, input);
}

export function releaseCoupon(tx: Tx, orderId: string): Promise<void> {
  return cancelCouponUsage(tx, orderId);
}
