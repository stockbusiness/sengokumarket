import crypto from 'crypto';
import { Router } from 'express';
import multer from 'multer';
import { put } from '@vercel/blob';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';

const router = Router();

const ITEM_TYPES = ['nft', 'physical', 'service', 'membership', 'fee'];
const STATUSES = ['draft', 'published', 'archived'];

// 仕様書外の拡張: 商品画像アップロード。Vercelのサーバーレス実行環境はローカルディスクが
// 永続化されないため、ディスクに書かず(memoryStorage)Vercel Blobへ直接アップロードする。
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function normalizeImages(images: unknown): string[] | undefined {
  if (images === undefined) return undefined;
  if (!Array.isArray(images)) return [];
  return images.filter((v): v is string => isNonEmptyString(v));
}

router.get('/products', async (_req, res) => {
  const products = await prisma.product.findMany({
    include: { variants: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ products });
});

router.post('/products', async (req, res) => {
  const { name, slug, description, category, itemType, basePrice, status, images, variants } = req.body ?? {};

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
      images: normalizeImages(images) ?? [],
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
  const { name, description, category, itemType, basePrice, status, images, variants } = req.body ?? {};

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
        images: normalizeImages(images),
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

// 仕様書外の拡張: 誤って追加したバリエーション(名前の付け間違い等)を削除できるようにする。
// 注文実績(order_items/nft_issues)があるバリエーションは削除させない。
router.delete('/products/:productId/variants/:variantId', async (req, res) => {
  const { productId, variantId } = req.params;

  const variant = await prisma.productVariant.findUnique({ where: { id: variantId } });
  if (!variant || variant.productId !== productId) {
    return sendError(res, 404, 'VARIANT_NOT_FOUND', 'バリエーションが見つかりません');
  }

  const orderItemCount = await prisma.orderItem.count({ where: { variantId } });
  if (orderItemCount > 0) {
    return sendError(res, 409, 'VARIANT_HAS_ORDERS', 'このバリエーションは注文実績があるため削除できません');
  }

  await prisma.productVariant.delete({ where: { id: variantId } });

  const product = await prisma.product.findUnique({ where: { id: productId }, include: { variants: true } });
  res.json({ product });
});

router.post('/products/upload-image', (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return sendError(res, 400, 'VALIDATION_ERROR', '画像ファイルは5MB以下にしてください');
    }
    if (err) return next(err);

    void (async () => {
      if (!req.file) {
        return sendError(res, 400, 'VALIDATION_ERROR', '画像ファイルを選択してください');
      }
      const ext = ALLOWED_IMAGE_TYPES[req.file.mimetype];
      if (!ext) {
        return sendError(res, 400, 'VALIDATION_ERROR', '対応していない画像形式です(jpeg/png/webp/gifのみ)');
      }
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return sendError(res, 503, 'BLOB_NOT_CONFIGURED', '画像アップロード機能が未設定です');
      }

      try {
        const blob = await put(`products/${crypto.randomUUID()}.${ext}`, req.file.buffer, {
          access: 'public',
          contentType: req.file.mimetype,
        });
        res.status(201).json({ url: blob.url });
      } catch (e) {
        console.error('product image upload failed', e);
        sendError(res, 500, 'UPLOAD_FAILED', '画像のアップロードに失敗しました');
      }
    })();
  });
});

// 仕様書外の拡張: 注文実績(order_items/nft_issues)がある商品は、スナップショット原則を
// 崩さないよう物理削除を許可しない(409。非公開・アーカイブでの運用を案内する)。
router.delete('/products/:id', async (req, res) => {
  const { id } = req.params;

  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) return sendError(res, 404, 'PRODUCT_NOT_FOUND', '商品が見つかりません');

  const orderItemCount = await prisma.orderItem.count({ where: { productId: id } });
  if (orderItemCount > 0) {
    return sendError(
      res,
      409,
      'PRODUCT_HAS_ORDERS',
      'この商品は注文実績があるため削除できません。表示したくない場合はステータスを「archived」にしてください',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.couponProduct.deleteMany({ where: { productId: id } });
    await tx.productVariant.deleteMany({ where: { productId: id } });
    await tx.product.delete({ where: { id } });
  });

  res.json({ success: true });
});

export default router;
