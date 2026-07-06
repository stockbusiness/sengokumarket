import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';

const router = Router();

const ITEM_TYPES = ['nft', 'physical', 'service', 'membership', 'fee'];
const STATUSES = ['draft', 'published', 'archived'];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

router.get('/products', async (_req, res) => {
  const products = await prisma.product.findMany({
    include: { variants: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ products });
});

router.post('/products', async (req, res) => {
  const { name, slug, description, category, itemType, basePrice, status, imageUrl, variants } = req.body ?? {};

  if (!isNonEmptyString(name)) return sendError(res, 400, 'VALIDATION_ERROR', '商品名を入力してください');
  if (!isNonEmptyString(slug) || !/^[a-z0-9-]+$/.test(slug)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'slugは半角英数とハイフンのみで入力してください');
  }
  if (!isNonEmptyString(category)) return sendError(res, 400, 'VALIDATION_ERROR', 'カテゴリを入力してください');
  if (!ITEM_TYPES.includes(itemType)) return sendError(res, 400, 'VALIDATION_ERROR', '商品タイプが不正です');
  if (!Number.isInteger(basePrice) || basePrice < 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', '価格は0以上の整数で入力してください');
  }
  const resolvedStatus = STATUSES.includes(status) ? status : 'draft';

  const existing = await prisma.product.findUnique({ where: { slug } });
  if (existing) return sendError(res, 409, 'SLUG_ALREADY_EXISTS', 'このslugは既に使用されています');

  const product = await prisma.product.create({
    data: {
      name,
      slug,
      description: isNonEmptyString(description) ? description : null,
      category,
      itemType,
      basePrice,
      status: resolvedStatus,
      imageUrl: isNonEmptyString(imageUrl) ? imageUrl : null,
      variants: Array.isArray(variants)
        ? {
            create: variants.map((v: { name: string; sku?: string; price: number; stock?: number }) => ({
              name: v.name,
              sku: v.sku ?? null,
              price: v.price,
              stock: v.stock ?? 0,
            })),
          }
        : undefined,
    },
    include: { variants: true },
  });

  res.status(201).json({ product });
});

router.put('/products/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description, category, itemType, basePrice, status, imageUrl, variants } = req.body ?? {};

  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) return sendError(res, 404, 'PRODUCT_NOT_FOUND', '商品が見つかりません');

  if (itemType !== undefined && !ITEM_TYPES.includes(itemType)) {
    return sendError(res, 400, 'VALIDATION_ERROR', '商品タイプが不正です');
  }
  if (status !== undefined && !STATUSES.includes(status)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ステータスが不正です');
  }
  if (basePrice !== undefined && (!Number.isInteger(basePrice) || basePrice < 0)) {
    return sendError(res, 400, 'VALIDATION_ERROR', '価格は0以上の整数で入力してください');
  }

  await prisma.$transaction(async (tx) => {
    await tx.product.update({
      where: { id },
      data: {
        name: isNonEmptyString(name) ? name : undefined,
        description: description === undefined ? undefined : description,
        category: isNonEmptyString(category) ? category : undefined,
        itemType: itemType ?? undefined,
        basePrice: basePrice ?? undefined,
        status: status ?? undefined,
        imageUrl: imageUrl === undefined ? undefined : imageUrl,
      },
    });

    if (Array.isArray(variants)) {
      for (const v of variants as { id?: string; name: string; sku?: string; price: number; stock?: number }[]) {
        if (v.id) {
          await tx.productVariant.update({
            where: { id: v.id },
            data: { name: v.name, sku: v.sku ?? null, price: v.price, stock: v.stock ?? undefined },
          });
        } else {
          await tx.productVariant.create({
            data: { productId: id, name: v.name, sku: v.sku ?? null, price: v.price, stock: v.stock ?? 0 },
          });
        }
      }
    }
  });

  const product = await prisma.product.findUnique({ where: { id }, include: { variants: true } });
  res.json({ product });
});

export default router;
