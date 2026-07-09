import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { generateCouponCode } from '../../services/couponCodeGenerator';

const router = Router();

const DISCOUNT_TYPES = ['fixed', 'percentage'];
const PRODUCT_SCOPE_TYPES = ['all', 'include', 'exclude'];
const AGENCY_SCOPE_TYPES = ['all', 'include'];
// event_participant / gacha_result は将来のガチャシステム連携用に予約(今回は未実装)。
const CUSTOMER_SCOPE_TYPES = ['all', 'include', 'new_customer'];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPositiveInt(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) > 0;
}

function isNonNegativeInt(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0;
}

function parseDate(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const d = new Date(v as string);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

interface CouponBody {
  name?: unknown;
  code?: unknown;
  description?: unknown;
  discountType?: unknown;
  discountAmount?: unknown;
  discountPercentage?: unknown;
  maximumDiscountAmount?: unknown;
  minimumOrderAmount?: unknown;
  startsAt?: unknown;
  expiresAt?: unknown;
  totalUsageLimit?: unknown;
  perCustomerUsageLimit?: unknown;
  productScopeType?: unknown;
  agencyScopeType?: unknown;
  customerScopeType?: unknown;
  isActive?: unknown;
  restoreOnCancel?: unknown;
  productIds?: unknown;
  agencyIds?: unknown;
  customerIds?: unknown;
}

function validateDiscountFields(body: CouponBody): { code: string; message: string } | null {
  if (!DISCOUNT_TYPES.includes(body.discountType as string)) {
    return { code: 'VALIDATION_ERROR', message: '割引種別はfixedまたはpercentageを指定してください' };
  }
  if (body.discountType === 'fixed' && !isPositiveInt(body.discountAmount)) {
    return { code: 'VALIDATION_ERROR', message: '固定額割引には1円以上の整数を指定してください' };
  }
  if (body.discountType === 'percentage') {
    const rate = body.discountPercentage;
    if (typeof rate !== 'number' || rate <= 0 || rate > 100) {
      return { code: 'VALIDATION_ERROR', message: '割引率は0より大きく100以下の数値を指定してください' };
    }
  }
  if (body.maximumDiscountAmount !== undefined && body.maximumDiscountAmount !== null && !isNonNegativeInt(body.maximumDiscountAmount)) {
    return { code: 'VALIDATION_ERROR', message: '最大割引額は0以上の整数を指定してください' };
  }
  if (body.minimumOrderAmount !== undefined && body.minimumOrderAmount !== null && !isNonNegativeInt(body.minimumOrderAmount)) {
    return { code: 'VALIDATION_ERROR', message: '最低購入金額は0以上の整数を指定してください' };
  }
  if (body.totalUsageLimit !== undefined && body.totalUsageLimit !== null && !isPositiveInt(body.totalUsageLimit)) {
    return { code: 'VALIDATION_ERROR', message: '総利用回数は1以上の整数を指定してください' };
  }
  if (body.perCustomerUsageLimit !== undefined && !isPositiveInt(body.perCustomerUsageLimit)) {
    return { code: 'VALIDATION_ERROR', message: '顧客ごとの利用回数は1以上の整数を指定してください' };
  }
  if (body.productScopeType !== undefined && !PRODUCT_SCOPE_TYPES.includes(body.productScopeType as string)) {
    return { code: 'VALIDATION_ERROR', message: '対象商品の指定方法が不正です' };
  }
  if (body.agencyScopeType !== undefined && !AGENCY_SCOPE_TYPES.includes(body.agencyScopeType as string)) {
    return { code: 'VALIDATION_ERROR', message: '対象代理店の指定方法が不正です' };
  }
  if (body.customerScopeType !== undefined && !CUSTOMER_SCOPE_TYPES.includes(body.customerScopeType as string)) {
    return { code: 'VALIDATION_ERROR', message: '対象顧客の指定方法が不正です' };
  }
  return null;
}

function serializeCoupon(coupon: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  discountType: string;
  discountAmount: number | null;
  discountPercentage: { toNumber(): number } | null;
  maximumDiscountAmount: number | null;
  minimumOrderAmount: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  totalUsageLimit: number | null;
  perCustomerUsageLimit: number;
  usedCount: number;
  reservedCount: number;
  productScopeType: string;
  agencyScopeType: string;
  customerScopeType: string;
  stackable: boolean;
  isActive: boolean;
  restoreOnCancel: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}) {
  return {
    ...coupon,
    discountPercentage: coupon.discountPercentage?.toNumber() ?? null,
  };
}

router.get('/coupons', async (req, res) => {
  const { status, q } = req.query;

  const where: Record<string, unknown> = { deletedAt: null };
  if (status === 'active') where.isActive = true;
  if (status === 'inactive') where.isActive = false;
  if (isNonEmptyString(q)) {
    where.OR = [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }];
  }

  const coupons = await prisma.coupon.findMany({ where, orderBy: { createdAt: 'desc' } });
  res.json({ coupons: coupons.map(serializeCoupon) });
});

router.get('/coupons/:id', async (req, res) => {
  const coupon = await prisma.coupon.findUnique({
    where: { id: req.params.id },
    include: {
      products: { include: { product: { select: { id: true, name: true } } } },
      agencies: { include: { agency: { select: { id: true, name: true } } } },
      customers: { include: { user: { select: { id: true, name: true, email: true } } } },
    },
  });
  if (!coupon || coupon.deletedAt) return sendError(res, 404, 'COUPON_NOT_FOUND', 'クーポンが見つかりません');
  res.json({ coupon: serializeCoupon(coupon), products: coupon.products, agencies: coupon.agencies, customers: coupon.customers });
});

router.get('/coupons/:id/usages', async (req, res) => {
  const coupon = await prisma.coupon.findUnique({ where: { id: req.params.id } });
  if (!coupon || coupon.deletedAt) return sendError(res, 404, 'COUPON_NOT_FOUND', 'クーポンが見つかりません');

  const usages = await prisma.couponUsage.findMany({
    where: { couponId: coupon.id },
    orderBy: { createdAt: 'desc' },
    include: { order: { select: { orderNumber: true } } },
  });
  res.json({ usages });
});

router.post('/coupons', async (req, res) => {
  const body = (req.body ?? {}) as CouponBody;

  if (!isNonEmptyString(body.name)) return sendError(res, 400, 'VALIDATION_ERROR', 'クーポン名を入力してください');

  const discountError = validateDiscountFields(body);
  if (discountError) return sendError(res, 400, discountError.code, discountError.message);

  const startsAt = parseDate(body.startsAt);
  const expiresAt = parseDate(body.expiresAt);
  if ((startsAt === undefined && body.startsAt !== undefined) || (expiresAt === undefined && body.expiresAt !== undefined)) {
    return sendError(res, 400, 'VALIDATION_ERROR', '日時の形式が不正です');
  }
  if (startsAt && expiresAt && expiresAt <= startsAt) {
    return sendError(res, 400, 'VALIDATION_ERROR', '有効期限は利用開始日時より後にしてください');
  }

  const productIds = Array.isArray(body.productIds) ? body.productIds.filter(isNonEmptyString) : [];
  const agencyIds = Array.isArray(body.agencyIds) ? body.agencyIds.filter(isNonEmptyString) : [];
  const customerIds = Array.isArray(body.customerIds) ? body.customerIds.filter(isNonEmptyString) : [];

  try {
    const coupon = await prisma.$transaction(async (tx) => {
      let code: string;
      if (isNonEmptyString(body.code)) {
        code = body.code.trim().toUpperCase();
        const existing = await tx.coupon.findUnique({ where: { code } });
        if (existing) throw Object.assign(new Error('CODE_TAKEN'), { httpCode: 'COUPON_CODE_ALREADY_EXISTS' });
      } else {
        code = await generateCouponCode(tx);
      }

      const created = await tx.coupon.create({
        data: {
          code,
          name: body.name as string,
          description: isNonEmptyString(body.description) ? body.description : null,
          discountType: body.discountType as string,
          discountAmount: body.discountType === 'fixed' ? (body.discountAmount as number) : null,
          discountPercentage: body.discountType === 'percentage' ? (body.discountPercentage as number) : null,
          maximumDiscountAmount: (body.maximumDiscountAmount as number | null) ?? null,
          minimumOrderAmount: (body.minimumOrderAmount as number | null) ?? null,
          startsAt: startsAt ?? null,
          expiresAt: expiresAt ?? null,
          totalUsageLimit: (body.totalUsageLimit as number | null) ?? null,
          perCustomerUsageLimit: (body.perCustomerUsageLimit as number) ?? 1,
          productScopeType: (body.productScopeType as string) ?? 'all',
          agencyScopeType: (body.agencyScopeType as string) ?? 'all',
          customerScopeType: (body.customerScopeType as string) ?? 'all',
          isActive: body.isActive !== false,
          restoreOnCancel: body.restoreOnCancel !== false,
          createdByAdminId: req.authUser!.id,
          products: productIds.length
            ? { create: productIds.map((productId) => ({ productId, relationType: body.productScopeType === 'exclude' ? 'exclude' : 'include' })) }
            : undefined,
          agencies: agencyIds.length ? { create: agencyIds.map((agencyId) => ({ agencyId })) } : undefined,
          customers: customerIds.length ? { create: customerIds.map((userId) => ({ userId })) } : undefined,
        },
      });

      return created;
    });

    res.status(201).json({ coupon: serializeCoupon(coupon) });
  } catch (e) {
    if (e instanceof Error && (e as { httpCode?: string }).httpCode === 'COUPON_CODE_ALREADY_EXISTS') {
      return sendError(res, 409, 'COUPON_CODE_ALREADY_EXISTS', 'このクーポンコードは既に使用されています');
    }
    throw e;
  }
});

router.patch('/coupons/:id', async (req, res) => {
  const existing = await prisma.coupon.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.deletedAt) return sendError(res, 404, 'COUPON_NOT_FOUND', 'クーポンが見つかりません');

  const body = (req.body ?? {}) as CouponBody;

  const mergedDiscountType = (body.discountType as string) ?? existing.discountType;
  if (body.discountType !== undefined || body.discountAmount !== undefined || body.discountPercentage !== undefined) {
    const discountError = validateDiscountFields({
      ...body,
      discountType: mergedDiscountType,
      discountAmount: body.discountAmount ?? (mergedDiscountType === 'fixed' ? existing.discountAmount : undefined),
      discountPercentage: body.discountPercentage ?? (mergedDiscountType === 'percentage' ? existing.discountPercentage?.toNumber() : undefined),
    });
    if (discountError) return sendError(res, 400, discountError.code, discountError.message);
  }

  const startsAt = parseDate(body.startsAt);
  const expiresAt = parseDate(body.expiresAt);
  if (startsAt === undefined && body.startsAt !== undefined) {
    return sendError(res, 400, 'VALIDATION_ERROR', '日時の形式が不正です');
  }
  if (expiresAt === undefined && body.expiresAt !== undefined) {
    return sendError(res, 400, 'VALIDATION_ERROR', '日時の形式が不正です');
  }

  const coupon = await prisma.coupon.update({
    where: { id: existing.id },
    data: {
      name: isNonEmptyString(body.name) ? body.name : undefined,
      description: body.description === undefined ? undefined : isNonEmptyString(body.description) ? body.description : null,
      discountType: body.discountType as string | undefined,
      discountAmount: body.discountType === 'fixed' ? (body.discountAmount as number) : body.discountType === 'percentage' ? null : undefined,
      discountPercentage:
        body.discountType === 'percentage' ? (body.discountPercentage as number) : body.discountType === 'fixed' ? null : undefined,
      maximumDiscountAmount: body.maximumDiscountAmount === undefined ? undefined : body.maximumDiscountAmount,
      minimumOrderAmount: body.minimumOrderAmount === undefined ? undefined : body.minimumOrderAmount,
      startsAt: body.startsAt === undefined ? undefined : startsAt,
      expiresAt: body.expiresAt === undefined ? undefined : expiresAt,
      totalUsageLimit: body.totalUsageLimit === undefined ? undefined : body.totalUsageLimit,
      perCustomerUsageLimit: body.perCustomerUsageLimit as number | undefined,
      productScopeType: body.productScopeType as string | undefined,
      agencyScopeType: body.agencyScopeType as string | undefined,
      customerScopeType: body.customerScopeType as string | undefined,
      isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
      restoreOnCancel: typeof body.restoreOnCancel === 'boolean' ? body.restoreOnCancel : undefined,
    },
  });

  res.json({ coupon: serializeCoupon(coupon) });
});

router.delete('/coupons/:id', async (req, res) => {
  const existing = await prisma.coupon.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.deletedAt) return sendError(res, 404, 'COUPON_NOT_FOUND', 'クーポンが見つかりません');

  // 過去の注文履歴からの参照(orders.coupon_id等)を保つため、物理削除ではなく論理削除する(仕様書23章)。
  await prisma.coupon.update({ where: { id: existing.id }, data: { deletedAt: new Date(), isActive: false } });
  res.status(204).end();
});

router.post('/coupons/:id/duplicate', async (req, res) => {
  const existing = await prisma.coupon.findUnique({
    where: { id: req.params.id },
    include: { products: true, agencies: true, customers: true },
  });
  if (!existing || existing.deletedAt) return sendError(res, 404, 'COUPON_NOT_FOUND', 'クーポンが見つかりません');

  const coupon = await prisma.$transaction(async (tx) => {
    const code = await generateCouponCode(tx, existing.code.split('-')[0]);
    return tx.coupon.create({
      data: {
        code,
        name: `${existing.name}(コピー)`,
        description: existing.description,
        discountType: existing.discountType,
        discountAmount: existing.discountAmount,
        discountPercentage: existing.discountPercentage,
        maximumDiscountAmount: existing.maximumDiscountAmount,
        minimumOrderAmount: existing.minimumOrderAmount,
        startsAt: existing.startsAt,
        expiresAt: existing.expiresAt,
        totalUsageLimit: existing.totalUsageLimit,
        perCustomerUsageLimit: existing.perCustomerUsageLimit,
        productScopeType: existing.productScopeType,
        agencyScopeType: existing.agencyScopeType,
        customerScopeType: existing.customerScopeType,
        stackable: existing.stackable,
        isActive: false,
        restoreOnCancel: existing.restoreOnCancel,
        createdByAdminId: req.authUser!.id,
        products: existing.products.length
          ? { create: existing.products.map((p) => ({ productId: p.productId, relationType: p.relationType })) }
          : undefined,
        agencies: existing.agencies.length ? { create: existing.agencies.map((a) => ({ agencyId: a.agencyId })) } : undefined,
        customers: existing.customers.length ? { create: existing.customers.map((c) => ({ userId: c.userId })) } : undefined,
      },
    });
  });

  res.status(201).json({ coupon: serializeCoupon(coupon) });
});

router.post('/coupons/:id/activate', async (req, res) => {
  const existing = await prisma.coupon.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.deletedAt) return sendError(res, 404, 'COUPON_NOT_FOUND', 'クーポンが見つかりません');

  const coupon = await prisma.coupon.update({ where: { id: existing.id }, data: { isActive: true } });
  res.json({ coupon: serializeCoupon(coupon) });
});

router.post('/coupons/:id/deactivate', async (req, res) => {
  const existing = await prisma.coupon.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.deletedAt) return sendError(res, 404, 'COUPON_NOT_FOUND', 'クーポンが見つかりません');

  const coupon = await prisma.coupon.update({ where: { id: existing.id }, data: { isActive: false } });
  res.json({ coupon: serializeCoupon(coupon) });
});

export default router;
