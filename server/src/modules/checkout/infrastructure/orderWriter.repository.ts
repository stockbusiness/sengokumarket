import type { Order, OrderItem, Prisma } from '@prisma/client';
import type { AgencyHierarchyNode } from '../../../services/referral';

type Tx = Prisma.TransactionClient;

export interface CreateOrderData {
  orderNumber: string;
  userId: string;
  totalAmount: number;
  originalAmount: number;
  paymentMethod: 'stripe' | 'bank_transfer';
  referralCode: string | null;
  referrerName: string | null;
  agencyName: string | null;
  agencyId: string | null;
  influencerId: string | null;
  referralLinkId: string | null;
  commissionRate: number;
  // 仕様書外の拡張: agencyIdの祖先チェーン(記録のみ目的。報酬計算には使わない)。
  agencyHierarchy: AgencyHierarchyNode[];
  explainerName: string | null;
  explainerAgencyId: string | null;
  explainerInfluencerId: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerPostalCode: string;
  customerAddress: string;
  termsVersion: string;
  guestAccountCreated: boolean;
}

// 注文のスナップショット原則(コーディング規約): 注文に関わる名称・価格・率は注文時点の値を
// 保存し、マスタ参照で表示しない。
export function createOrder(tx: Tx, data: CreateOrderData): Promise<Order> {
  const now = new Date();
  return tx.order.create({
    data: {
      orderNumber: data.orderNumber,
      userId: data.userId,
      totalAmount: data.totalAmount,
      originalAmount: data.originalAmount,
      paymentStatus: 'pending',
      orderStatus: 'pending',
      paymentMethod: data.paymentMethod,
      referralCode: data.referralCode,
      referrerName: data.referrerName,
      agencyName: data.agencyName,
      agencyId: data.agencyId,
      influencerId: data.influencerId,
      referralLinkId: data.referralLinkId,
      commissionRate: data.commissionRate,
      referralHierarchy: data.agencyHierarchy.length > 0 ? (data.agencyHierarchy as never) : undefined,
      explainerName: data.explainerName,
      explainerAgencyId: data.explainerAgencyId,
      explainerInfluencerId: data.explainerInfluencerId,
      customerName: data.customerName,
      customerEmail: data.customerEmail,
      customerPhone: data.customerPhone,
      customerPostalCode: data.customerPostalCode,
      customerAddress: data.customerAddress,
      termsAgreedAt: now,
      termsVersion: data.termsVersion,
      guestAccountCreated: data.guestAccountCreated,
    },
  });
}

export interface OrderItemData {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string;
  itemType: string;
  quantity: number;
  unitPrice: number;
}

export async function createOrderItems(tx: Tx, orderId: string, items: OrderItemData[]): Promise<OrderItem[]> {
  await tx.orderItem.createMany({
    data: items.map((item) => ({
      orderId,
      productId: item.productId,
      variantId: item.variantId,
      productName: item.productName,
      variantName: item.variantName,
      itemType: item.itemType,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.unitPrice * item.quantity,
    })),
  });
  return tx.orderItem.findMany({ where: { orderId } });
}

export interface CouponPricingSnapshot {
  finalAmount: number;
  discountAmount: number;
  couponId: string;
  couponCode: string;
}

// 仕様書外の拡張(クーポン機能): totalAmountを最終決済額へ更新し、割引額・適用クーポンを
// スナップショットする(originalAmountは変更しない)。
export function applyCouponPricing(tx: Tx, orderId: string, pricing: CouponPricingSnapshot): Promise<Order> {
  return tx.order.update({
    where: { id: orderId },
    data: {
      totalAmount: pricing.finalAmount,
      couponDiscountAmount: pricing.discountAmount,
      couponId: pricing.couponId,
      couponCode: pricing.couponCode,
    },
  });
}
