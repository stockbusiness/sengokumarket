import type { Order, OrderItem } from '@prisma/client';

export interface CheckoutItemInput {
  variantId: string;
  quantity: number;
}

export interface CreatePendingOrderInput {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerPostalCode: string;
  customerAddress: string;
  referralCode?: string | null;
  // 仕様書外の拡張(クーポン機能): 購入者が手入力したクーポンコード。指定が無い場合、
  // 紹介リンクにcoupon_auto_apply=trueで設定されたクーポンがあればそちらを自動適用する。
  couponCode?: string | null;
  // 仕様書外の拡張: 紹介コードの持ち主とは別に、購入者に商品を説明した担当者名(任意・自由入力)。
  explainerName?: string | null;
  agreedToTerms: boolean;
  items: CheckoutItemInput[];
  paymentMethod?: 'stripe' | 'bank_transfer';
}

export interface CreatePendingOrderResult {
  order: Order;
  items: OrderItem[];
}

// FOR UPDATEで取得する商品・バリエーションの行(在庫判定・販売方式判定・価格計算・
// 注文明細スナップショットの元データ)。DB(snake_case)の生SQL結果はrepositoryでこの型へ変換する。
export interface CheckoutVariantRow {
  variantId: string;
  variantName: string;
  price: number;
  stock: number;
  reservedStock: number;
  productId: string;
  productName: string;
  itemType: string;
  status: string;
  salesModel: string;
}
