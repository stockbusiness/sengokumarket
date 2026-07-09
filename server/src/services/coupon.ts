import type { Coupon, Prisma } from '@prisma/client';
import { HttpError } from '../lib/httpError';

type Tx = Prisma.TransactionClient;

// 仕様書外の拡張: クーポン機能(sengoku_nft_cart_coupon_implementation_spec)。
// 価格計算・利用可否判定はすべてサーバー側(この関数)で行い、クライアントの送信値は信用しない(仕様書2.3)。

export interface CouponEligibilityItem {
  productId: string;
  subtotal: number;
}

export interface CouponValidationInput {
  code: string;
  userId: string | null;
  agencyId: string | null;
  items: CouponEligibilityItem[];
}

export interface CouponPricing {
  coupon: Coupon;
  eligibleAmount: number;
  discountAmount: number;
  originalAmount: number;
  finalAmount: number;
}

async function loadCoupon(tx: Tx, code: string): Promise<Coupon> {
  const coupon = await tx.coupon.findUnique({ where: { code } });
  if (!coupon || coupon.deletedAt) {
    throw new HttpError(422, 'COUPON_NOT_FOUND', 'クーポンコードが正しくありません');
  }
  return coupon;
}

function assertActiveAndWithinPeriod(coupon: Coupon, now: Date) {
  if (!coupon.isActive) {
    throw new HttpError(422, 'COUPON_INACTIVE', 'このクーポンは現在ご利用いただけません');
  }
  if (coupon.startsAt && now < coupon.startsAt) {
    throw new HttpError(422, 'COUPON_NOT_STARTED', 'このクーポンはまだご利用いただけません');
  }
  if (coupon.expiresAt && now > coupon.expiresAt) {
    throw new HttpError(422, 'COUPON_EXPIRED', 'このクーポンは有効期限が切れています');
  }
}

async function filterEligibleItems(tx: Tx, coupon: Coupon, items: CouponEligibilityItem[]): Promise<CouponEligibilityItem[]> {
  if (coupon.productScopeType === 'all') return items;

  const entries = await tx.couponProduct.findMany({ where: { couponId: coupon.id } });
  const productIds = new Set(entries.map((e) => e.productId));

  const eligible =
    coupon.productScopeType === 'include' ? items.filter((i) => productIds.has(i.productId)) : items.filter((i) => !productIds.has(i.productId));

  if (eligible.length === 0) {
    throw new HttpError(422, 'COUPON_PRODUCT_NOT_ELIGIBLE', 'この商品には利用できません');
  }
  return eligible;
}

async function assertAgencyScope(tx: Tx, coupon: Coupon, agencyId: string | null) {
  if (coupon.agencyScopeType === 'all') return;
  if (!agencyId) {
    throw new HttpError(422, 'COUPON_AGENCY_NOT_ELIGIBLE', 'この代理店経由では利用できません');
  }
  const entry = await tx.couponAgency.findUnique({ where: { couponId_agencyId: { couponId: coupon.id, agencyId } } });
  if (!entry) {
    throw new HttpError(422, 'COUPON_AGENCY_NOT_ELIGIBLE', 'この代理店経由では利用できません');
  }
}

async function assertCustomerScope(tx: Tx, coupon: Coupon, userId: string | null) {
  if (coupon.customerScopeType === 'all') return;

  if (!userId) {
    throw new HttpError(422, 'COUPON_CUSTOMER_NOT_ELIGIBLE', 'この購入者は利用対象外です');
  }

  if (coupon.customerScopeType === 'include') {
    const entry = await tx.couponCustomer.findUnique({ where: { couponId_userId: { couponId: coupon.id, userId } } });
    if (!entry) throw new HttpError(422, 'COUPON_CUSTOMER_NOT_ELIGIBLE', 'この購入者は利用対象外です');
    return;
  }

  if (coupon.customerScopeType === 'new_customer') {
    const priorPaidOrder = await tx.order.findFirst({ where: { userId, paymentStatus: 'paid' } });
    if (priorPaidOrder) throw new HttpError(422, 'COUPON_CUSTOMER_NOT_ELIGIBLE', 'この購入者は利用対象外です');
    return;
  }

  // event_participant / gacha_result は将来のガチャシステム連携用に予約した値で、今回は未実装。
  throw new HttpError(422, 'COUPON_CUSTOMER_NOT_ELIGIBLE', 'この購入者は利用対象外です');
}

async function assertUsageLimits(tx: Tx, coupon: Coupon, userId: string | null) {
  if (coupon.totalUsageLimit !== null) {
    const consumed = coupon.usedCount + coupon.reservedCount;
    if (consumed >= coupon.totalUsageLimit) {
      throw new HttpError(422, 'COUPON_USAGE_LIMIT_REACHED', '利用回数の上限に達しています');
    }
  }

  if (userId) {
    const customerUsageCount = await tx.couponUsage.count({
      where: { couponId: coupon.id, userId, status: { in: ['reserved', 'used'] } },
    });
    if (customerUsageCount >= coupon.perCustomerUsageLimit) {
      throw new HttpError(422, 'COUPON_ALREADY_USED', 'すでに利用済みです');
    }
  }
}

function calculateDiscountAmount(coupon: Coupon, eligibleAmount: number): number {
  if (eligibleAmount <= 0) return 0;

  let discount: number;
  if (coupon.discountType === 'fixed') {
    discount = coupon.discountAmount ?? 0;
  } else {
    const rate = coupon.discountPercentage?.toNumber() ?? 0;
    // 端数処理: 1円未満切り捨て(仕様書10.3)。
    discount = Math.floor((eligibleAmount * rate) / 100);
  }

  if (coupon.maximumDiscountAmount !== null && coupon.maximumDiscountAmount !== undefined) {
    discount = Math.min(discount, coupon.maximumDiscountAmount);
  }

  // 割引額が対象金額を超えない・最終金額が負にならないことを保証する(仕様書9.4)。
  return Math.min(discount, eligibleAmount);
}

// サーバー側で完結する検証+割引額計算(予約は行わない)。チェックアウト前のプレビュー、
// および実際の予約(reserveCouponUsage)の両方から呼ばれる共通ロジック(仕様書9章の検証順序)。
export async function validateCoupon(tx: Tx, input: CouponValidationInput): Promise<CouponPricing> {
  const coupon = await loadCoupon(tx, input.code);
  const now = new Date();

  assertActiveAndWithinPeriod(coupon, now);

  const originalAmount = input.items.reduce((sum, i) => sum + i.subtotal, 0);

  if (coupon.minimumOrderAmount !== null && coupon.minimumOrderAmount !== undefined && originalAmount < coupon.minimumOrderAmount) {
    throw new HttpError(422, 'COUPON_MINIMUM_NOT_MET', '最低購入金額に達していません');
  }

  const eligibleItems = await filterEligibleItems(tx, coupon, input.items);
  await assertAgencyScope(tx, coupon, input.agencyId);
  await assertCustomerScope(tx, coupon, input.userId);
  await assertUsageLimits(tx, coupon, input.userId);

  const eligibleAmount = eligibleItems.reduce((sum, i) => sum + i.subtotal, 0);
  const discountAmount = calculateDiscountAmount(coupon, eligibleAmount);
  const finalAmount = originalAmount - discountAmount;

  return { coupon, eligibleAmount, discountAmount, originalAmount, finalAmount };
}

export interface ReserveCouponUsageResult extends CouponPricing {
  usageId: string;
}

// 決済開始時にクーポン利用を一時予約する(仕様書11.1)。有効期限はStripe Checkout Sessionの
// 有効期限(30分)と揃える。
const RESERVATION_TTL_MS = 30 * 60 * 1000;

export async function reserveCouponUsage(tx: Tx, input: CouponValidationInput & { orderId: string }): Promise<ReserveCouponUsageResult> {
  // 在庫のreservedStockと同じ考え方: クーポン行をロックしてから検証・予約することで、
  // 同時実行下でも総利用回数・顧客ごとの利用回数の上限を超過させない。
  await tx.$queryRaw`SELECT id FROM coupons WHERE code = ${input.code} FOR UPDATE`;

  const pricing = await validateCoupon(tx, input);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS);

  const usage = await tx.couponUsage.create({
    data: {
      couponId: pricing.coupon.id,
      userId: input.userId,
      agencyId: input.agencyId,
      orderId: input.orderId,
      originalAmount: pricing.originalAmount,
      discountAmount: pricing.discountAmount,
      finalAmount: pricing.finalAmount,
      status: 'reserved',
      reservedAt: now,
      expiresAt,
    },
  });

  await tx.coupon.update({ where: { id: pricing.coupon.id }, data: { reservedCount: { increment: 1 } } });

  return { ...pricing, usageId: usage.id };
}

// 決済完了時にreserved→usedへ確定する(仕様書11.2)。applyPaidOrderSideEffectsから呼ぶ。
export async function confirmCouponUsage(tx: Tx, orderId: string): Promise<void> {
  const usage = await tx.couponUsage.findUnique({ where: { orderId } });
  if (!usage || usage.status !== 'reserved') return;

  await tx.couponUsage.update({ where: { id: usage.id }, data: { status: 'used', usedAt: new Date() } });
  await tx.coupon.update({
    where: { id: usage.couponId },
    data: { usedCount: { increment: 1 }, reservedCount: { decrement: 1 } },
  });
}

// 決済失敗・期限切れ時にreservedを解放する(仕様書11.1/11.3)。
export async function cancelCouponUsage(tx: Tx, orderId: string, reason: 'cancelled' | 'expired' = 'cancelled'): Promise<void> {
  const usage = await tx.couponUsage.findUnique({ where: { orderId } });
  if (!usage || usage.status !== 'reserved') return;

  await tx.couponUsage.update({ where: { id: usage.id }, data: { status: reason, cancelledAt: new Date() } });
  await tx.coupon.update({ where: { id: usage.couponId }, data: { reservedCount: { decrement: 1 } } });
}

// 全額返金・注文キャンセル時、クーポン設定のrestoreOnCancelに従って再利用可能へ戻す(仕様書12.1)。
// 一部返金では呼ばない(仕様書12.2: 初期実装ではクーポンを復活させない)。
export async function restoreCouponUsageOnFullRefund(tx: Tx, orderId: string): Promise<void> {
  const usage = await tx.couponUsage.findUnique({ where: { orderId }, include: { coupon: true } });
  if (!usage || usage.status !== 'used') return;
  if (!usage.coupon.restoreOnCancel) return;

  await tx.couponUsage.update({ where: { id: usage.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
  await tx.coupon.update({ where: { id: usage.couponId }, data: { usedCount: { decrement: 1 } } });
}
