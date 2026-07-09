import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { Order, OrderItem } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/httpError';
import { generateOrderNumber } from './orderNumber';
import { resolveReferral, resolveReferralByAttribution } from './referral';
import { isValidEmail } from '../lib/validation';
import { cancelCouponUsage, reserveCouponUsage } from './coupon';

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
  agreedToTerms: boolean;
  items: CheckoutItemInput[];
  paymentMethod?: 'stripe' | 'bank_transfer';
}

export interface CreatePendingOrderResult {
  order: Order;
  items: OrderItem[];
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function validateCreatePendingOrderInput(body: unknown): CreatePendingOrderInput {
  const b = body as Record<string, unknown>;

  if (!isNonEmptyString(b?.customerName)) throw new HttpError(400, 'VALIDATION_ERROR', '氏名を入力してください');
  if (!isNonEmptyString(b?.customerEmail) || !isValidEmail(b.customerEmail as string)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'メールアドレスを正しく入力してください');
  }
  if (!isNonEmptyString(b?.customerPhone)) throw new HttpError(400, 'VALIDATION_ERROR', '電話番号を入力してください');
  if (!isNonEmptyString(b?.customerPostalCode)) throw new HttpError(400, 'VALIDATION_ERROR', '郵便番号を入力してください');
  if (!isNonEmptyString(b?.customerAddress)) throw new HttpError(400, 'VALIDATION_ERROR', '住所を入力してください');
  if (b?.agreedToTerms !== true) {
    throw new HttpError(400, 'TERMS_NOT_AGREED', '利用規約・返金ポリシーへの同意が必要です');
  }
  if (!Array.isArray(b?.items) || b.items.length === 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'カートが空です');
  }
  const paymentMethod = b?.paymentMethod === 'bank_transfer' ? 'bank_transfer' : 'stripe';
  const items = (b.items as unknown[]).map((raw) => {
    const item = raw as Record<string, unknown>;
    if (!isNonEmptyString(item?.variantId) || !Number.isInteger(item.quantity) || (item.quantity as number) < 1) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'カートの内容が不正です');
    }
    return { variantId: item.variantId as string, quantity: item.quantity as number };
  });

  return {
    customerName: (b.customerName as string).trim(),
    customerEmail: (b.customerEmail as string).trim(),
    customerPhone: (b.customerPhone as string).trim(),
    customerPostalCode: (b.customerPostalCode as string).trim(),
    customerAddress: (b.customerAddress as string).trim(),
    referralCode: isNonEmptyString(b.referralCode) ? (b.referralCode as string).trim() : null,
    couponCode: isNonEmptyString(b.couponCode) ? (b.couponCode as string).trim().toUpperCase() : null,
    agreedToTerms: true,
    items,
    paymentMethod,
  };
}

interface VariantRow {
  variant_id: string;
  variant_name: string;
  price: number;
  stock: number;
  reserved_stock: number;
  product_id: string;
  product_name: string;
  item_type: string;
  status: string;
}

export async function createPendingOrder(input: CreatePendingOrderInput): Promise<CreatePendingOrderResult> {
  const termsVersion = process.env.TERMS_VERSION;
  if (!termsVersion) throw new HttpError(500, 'CONFIG_ERROR', 'TERMS_VERSIONが設定されていません');

  // ロック順序を揃えてデッドロックを防ぐ
  const sortedVariantIds = [...new Set(input.items.map((i) => i.variantId))].sort();

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<VariantRow[]>`
      SELECT
        pv.id AS variant_id,
        pv.name AS variant_name,
        pv.price AS price,
        pv.stock AS stock,
        pv.reserved_stock AS reserved_stock,
        p.id AS product_id,
        p.name AS product_name,
        p.item_type AS item_type,
        p.status AS status
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.id = ANY(${sortedVariantIds}::uuid[])
      ORDER BY pv.id
      FOR UPDATE OF pv
    `;
    const rowByVariantId = new Map(rows.map((r) => [r.variant_id, r]));

    for (const item of input.items) {
      const row = rowByVariantId.get(item.variantId);
      if (!row || row.status !== 'published') {
        throw new HttpError(404, 'PRODUCT_NOT_FOUND', '商品が見つかりません');
      }
      const availableStock = row.stock - row.reserved_stock;
      if (availableStock < item.quantity) {
        throw new HttpError(409, 'STOCK_INSUFFICIENT', `「${row.product_name} ${row.variant_name}」の在庫が不足しています`);
      }
    }

    for (const item of input.items) {
      await tx.productVariant.update({
        where: { id: item.variantId },
        data: { reservedStock: { increment: item.quantity } },
      });
    }

    let user = await tx.user.findUnique({ where: { email: input.customerEmail } });
    let guestAccountCreated = false;
    if (!user) {
      const randomPassword = crypto.randomBytes(32).toString('hex');
      user = await tx.user.create({
        data: {
          name: input.customerName,
          email: input.customerEmail,
          phone: input.customerPhone,
          passwordHash: await bcrypt.hash(randomPassword, 10),
          role: 'user',
        },
      });
      guestAccountCreated = true;
    }

    // 仕様書外の拡張: 代理店への帰属は初回購入時点で永久固定(以降どの紹介コードでアクセスしても変わらない)
    let referral;
    if (user.referredByAgencyId || user.referredByInfluencerId || user.referredByReferralLinkId) {
      referral = await resolveReferralByAttribution(tx, {
        agencyId: user.referredByAgencyId,
        influencerId: user.referredByInfluencerId,
        referralLinkId: user.referredByReferralLinkId,
        code: user.referredByCode,
      });
    } else {
      referral = await resolveReferral(tx, input.referralCode);
      if (referral.agencyId || referral.influencerId || referral.referralLinkId) {
        user = await tx.user.update({
          where: { id: user.id },
          data: {
            referredByAgencyId: referral.agencyId,
            referredByInfluencerId: referral.influencerId,
            referredByReferralLinkId: referral.referralLinkId,
            referredByCode: referral.referralCode,
            referredAt: new Date(),
          },
        });
      }
    }

    const orderNumber = await generateOrderNumber(tx);
    const now = new Date();

    const originalAmount = input.items.reduce((sum, item) => {
      const row = rowByVariantId.get(item.variantId)!;
      return sum + row.price * item.quantity;
    }, 0);

    let order = await tx.order.create({
      data: {
        orderNumber,
        userId: user.id,
        totalAmount: originalAmount,
        originalAmount,
        paymentStatus: 'pending',
        orderStatus: 'pending',
        paymentMethod: input.paymentMethod ?? 'stripe',
        referralCode: referral.referralCode,
        referrerName: referral.referrerName,
        agencyName: referral.agencyName,
        agencyId: referral.agencyId,
        influencerId: referral.influencerId,
        referralLinkId: referral.referralLinkId,
        commissionRate: referral.commissionRate,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        customerPhone: input.customerPhone,
        customerPostalCode: input.customerPostalCode,
        customerAddress: input.customerAddress,
        termsAgreedAt: now,
        termsVersion,
        guestAccountCreated,
      },
    });

    await tx.orderItem.createMany({
      data: input.items.map((item) => {
        const row = rowByVariantId.get(item.variantId)!;
        return {
          orderId: order.id,
          productId: row.product_id,
          variantId: item.variantId,
          productName: row.product_name,
          variantName: row.variant_name,
          itemType: row.item_type,
          quantity: item.quantity,
          unitPrice: row.price,
          subtotal: row.price * item.quantity,
        };
      }),
    });

    const items = await tx.orderItem.findMany({ where: { orderId: order.id } });

    // 仕様書外の拡張(クーポン機能): 手入力クーポンが指定されていればそれを優先し、
    // なければ紹介リンクに設定された自動適用クーポンを使う。
    const isManualCoupon = Boolean(input.couponCode);
    const effectiveCouponCode = input.couponCode ?? (referral.couponAutoApply ? referral.couponCode : null);

    if (effectiveCouponCode) {
      const reserve = () =>
        reserveCouponUsage(tx, {
          code: effectiveCouponCode,
          userId: user!.id,
          agencyId: referral.agencyId,
          items: items.map((i) => ({ productId: i.productId, subtotal: i.subtotal })),
          orderId: order.id,
        });

      // 手入力クーポンの検証失敗は購入者に見えるエラーとして中断する。自動適用クーポンの
      // 検証失敗(運用上の設定不備等)は購入自体を止めず、通常価格で購入を継続させる。
      const pricing = isManualCoupon ? await reserve() : await reserve().catch(() => null);

      if (pricing) {
        order = await tx.order.update({
          where: { id: order.id },
          data: {
            totalAmount: pricing.finalAmount,
            couponDiscountAmount: pricing.discountAmount,
            couponId: pricing.coupon.id,
            couponCode: pricing.coupon.code,
          },
        });
      }
    }

    return { order, items };
  });
}

// Stripe Checkout Session作成に失敗した場合の補償処理。
// 仮引当した在庫を解放し、注文は決済不可として扱う(再度カートからやり直してもらう)。
export async function cancelOrderReservation(orderId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.paymentStatus !== 'pending') return;

    const items = await tx.orderItem.findMany({ where: { orderId } });
    for (const item of items) {
      if (!item.variantId) continue;
      await tx.productVariant.update({
        where: { id: item.variantId },
        data: { reservedStock: { decrement: item.quantity } },
      });
    }

    await cancelCouponUsage(tx, orderId);
    await tx.order.update({ where: { id: orderId }, data: { paymentStatus: 'failed' } });
  });
}
