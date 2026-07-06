import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { Order, OrderItem } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/httpError';
import { generateOrderNumber } from './orderNumber';
import { resolveReferral } from './referral';
import { isValidEmail } from '../lib/validation';

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
  agreedToTerms: boolean;
  items: CheckoutItemInput[];
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
    agreedToTerms: true,
    items,
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

    const referral = await resolveReferral(tx, input.referralCode);

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

    const orderNumber = await generateOrderNumber(tx);
    const now = new Date();

    const totalAmount = input.items.reduce((sum, item) => {
      const row = rowByVariantId.get(item.variantId)!;
      return sum + row.price * item.quantity;
    }, 0);

    const order = await tx.order.create({
      data: {
        orderNumber,
        userId: user.id,
        totalAmount,
        paymentStatus: 'pending',
        orderStatus: 'pending',
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

    await tx.order.update({ where: { id: orderId }, data: { paymentStatus: 'failed' } });
  });
}
