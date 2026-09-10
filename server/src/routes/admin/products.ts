import crypto from 'crypto';
import { Router } from 'express';
import multer from 'multer';
import { put } from '@vercel/blob';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { AGENCY_ACCESS_MODES, ITEM_TYPES, PRODUCT_STATUSES as STATUSES, SALES_MODELS } from '@sengoku/contracts';

const router = Router();

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

interface AgencyAccessFields {
  agencyAccessMode?: string;
  agencyRole?: string | null;
  agencyProductCode?: string | null;
  agencyAccessExpiresDays?: number | null;
  agencyLoginRedirectPath?: string | null;
}

// 購入後代理店システム連携実装指示書 6.3章: agency_access_mode=agent_portalの場合は
// agencyRole・agencyProductCodeを必須にする(DB側もCHECK制約で二重に強制する)。
function validateAgencyAccessFields(input: AgencyAccessFields): string | null {
  if (input.agencyAccessMode !== undefined && !(AGENCY_ACCESS_MODES as readonly string[]).includes(input.agencyAccessMode)) {
    return '代理店ポータルアクセス権限が不正です';
  }
  if (
    input.agencyAccessMode === 'agent_portal' &&
    (!isNonEmptyString(input.agencyRole) || !isNonEmptyString(input.agencyProductCode))
  ) {
    return '代理店アカウント権限を付与する場合、agencyRoleとagencyProductCodeは必須です';
  }
  if (
    input.agencyAccessExpiresDays !== undefined &&
    input.agencyAccessExpiresDays !== null &&
    (!Number.isInteger(input.agencyAccessExpiresDays) || input.agencyAccessExpiresDays <= 0)
  ) {
    return 'アクセス有効日数は1以上の整数で入力してください';
  }
  return null;
}

router.get('/products', async (_req, res) => {
  const products = await prisma.product.findMany({
    include: { variants: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ products });
});

// 仕様書外の拡張: 商品編集ページ用に単体取得。
// 本番安定化指示書Stage6(9.5): 連携ルール(product_integration_rules)も編集画面が1回で
// 取得できるよう含める。
router.get('/products/:id', async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: req.params.id },
    include: { variants: true, integrationRules: { orderBy: { createdAt: 'asc' } } },
  });
  if (!product) return sendError(res, 404, 'PRODUCT_NOT_FOUND', '商品が見つかりません');
  res.json({ product });
});

router.post('/products', async (req, res) => {
  const {
    name,
    slug,
    description,
    category,
    itemType,
    salesModel,
    basePrice,
    status,
    images,
    variants,
    agencyAccessMode,
    agencyRole,
    agencyProductCode,
    agencyAccessExpiresDays,
    agencyLoginRedirectPath,
  } = req.body ?? {};

  if (!isNonEmptyString(name)) return sendError(res, 400, 'VALIDATION_ERROR', '商品名を入力してください');
  if (!isNonEmptyString(slug) || !/^[a-z0-9-]+$/.test(slug)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'slugは半角英数とハイフンのみで入力してください');
  }
  if (!isNonEmptyString(category)) return sendError(res, 400, 'VALIDATION_ERROR', 'カテゴリを入力してください');
  if (!ITEM_TYPES.includes(itemType)) return sendError(res, 400, 'VALIDATION_ERROR', '商品タイプが不正です');
  if (salesModel !== undefined && !SALES_MODELS.includes(salesModel)) {
    return sendError(res, 400, 'VALIDATION_ERROR', '販売方式が不正です');
  }
  if (!Number.isInteger(basePrice) || basePrice < 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', '価格は0以上の整数で入力してください');
  }
  const agencyAccessError = validateAgencyAccessFields({
    agencyAccessMode,
    agencyRole,
    agencyProductCode,
    agencyAccessExpiresDays,
  });
  if (agencyAccessError) return sendError(res, 400, 'VALIDATION_ERROR', agencyAccessError);
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
      salesModel: SALES_MODELS.includes(salesModel) ? salesModel : 'hybrid',
      basePrice,
      status: resolvedStatus,
      images: normalizeImages(images) ?? [],
      agencyAccessMode: (AGENCY_ACCESS_MODES as readonly string[]).includes(agencyAccessMode) ? agencyAccessMode : 'none',
      agencyRole: isNonEmptyString(agencyRole) ? agencyRole : null,
      agencyProductCode: isNonEmptyString(agencyProductCode) ? agencyProductCode : null,
      agencyAccessExpiresDays: typeof agencyAccessExpiresDays === 'number' ? agencyAccessExpiresDays : null,
      agencyLoginRedirectPath: isNonEmptyString(agencyLoginRedirectPath) ? agencyLoginRedirectPath : null,
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

type VariantUpdateEntry = { id: string; name?: string; sku?: string | null; price?: number; stock?: number };
type VariantCreateEntry = { name: string; sku?: string | null; price: number; stock?: number };

router.put('/products/:id', async (req, res) => {
  const { id } = req.params;
  const {
    name,
    description,
    category,
    itemType,
    salesModel,
    basePrice,
    status,
    images,
    variants,
    agencyAccessMode,
    agencyRole,
    agencyProductCode,
    agencyAccessExpiresDays,
    agencyLoginRedirectPath,
  } = req.body ?? {};

  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) return sendError(res, 404, 'PRODUCT_NOT_FOUND', '商品が見つかりません');

  if (itemType !== undefined && !ITEM_TYPES.includes(itemType)) {
    return sendError(res, 400, 'VALIDATION_ERROR', '商品タイプが不正です');
  }
  if (salesModel !== undefined && !SALES_MODELS.includes(salesModel)) {
    return sendError(res, 400, 'VALIDATION_ERROR', '販売方式が不正です');
  }
  if (status !== undefined && !STATUSES.includes(status)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ステータスが不正です');
  }
  if (basePrice !== undefined && (!Number.isInteger(basePrice) || basePrice < 0)) {
    return sendError(res, 400, 'VALIDATION_ERROR', '価格は0以上の整数で入力してください');
  }
  // PUTは部分更新のため、agencyAccessModeが省略された場合は既存値を基準に検証する
  // (例: 既にagent_portalの商品でagencyRoleだけをnullへ更新しようとする事故を防ぐ)。
  const agencyAccessError = validateAgencyAccessFields({
    agencyAccessMode: agencyAccessMode ?? existing.agencyAccessMode,
    agencyRole: agencyRole !== undefined ? agencyRole : existing.agencyRole,
    agencyProductCode: agencyProductCode !== undefined ? agencyProductCode : existing.agencyProductCode,
    agencyAccessExpiresDays: agencyAccessExpiresDays !== undefined ? agencyAccessExpiresDays : existing.agencyAccessExpiresDays,
  });
  if (agencyAccessError) return sendError(res, 400, 'VALIDATION_ERROR', agencyAccessError);

  // 仕様書外の拡張(2026-07-22指示書Stage3): variantsはPATCH相当の部分更新として扱う。
  // フロント側の在庫だけ編集する画面(AdminProductEditPage)は{ id, stock }のみを送るため、
  // 未指定フィールド(name・sku・price)を強制的に上書きすると既存値が消失・破損してしまう。
  // トランザクション開始前に検証し、途中で400/404を返す際にレスポンスの二重送信が起きないようにする。
  const updateEntries: VariantUpdateEntry[] = [];
  const createEntries: VariantCreateEntry[] = [];
  if (variants !== undefined) {
    if (!Array.isArray(variants)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'variantsは配列で指定してください');
    }

    const rawEntries = variants as { id?: string; name?: string; sku?: string | null; price?: number; stock?: number }[];

    for (const v of rawEntries) {
      if (v.price !== undefined && (!Number.isInteger(v.price) || v.price < 0)) {
        return sendError(res, 400, 'VALIDATION_ERROR', '価格は0以上の整数で入力してください');
      }
      if (v.stock !== undefined && (!Number.isInteger(v.stock) || v.stock < 0)) {
        return sendError(res, 400, 'VALIDATION_ERROR', '在庫数は0以上の整数で入力してください');
      }
    }

    const idsToUpdate = rawEntries.filter((v): v is VariantUpdateEntry & { id: string } => v.id !== undefined).map((v) => v.id);
    if (idsToUpdate.length > 0) {
      const matchingCount = await prisma.productVariant.count({ where: { id: { in: idsToUpdate }, productId: id } });
      if (matchingCount !== new Set(idsToUpdate).size) {
        return sendError(res, 404, 'VARIANT_NOT_FOUND', 'バリエーションが見つかりません');
      }
    }

    for (const v of rawEntries) {
      if (v.id !== undefined) {
        updateEntries.push({ id: v.id, name: v.name, sku: v.sku, price: v.price, stock: v.stock });
      } else {
        if (!isNonEmptyString(v.name) || v.price === undefined || !Number.isInteger(v.price) || v.price < 0) {
          return sendError(res, 400, 'VALIDATION_ERROR', '新規バリエーションには商品名と価格(0以上の整数)を入力してください');
        }
        createEntries.push({ name: v.name, sku: v.sku, price: v.price, stock: v.stock });
      }
    }
  }

  // 仕様書外の拡張: バリエーションが1件だけ(=実質バリエーション無しの単一商品)の場合に限り、
  // その1件の価格を代表価格(basePrice)と常に一致させる。管理画面で「代表価格」と
  // 「バリエーションの価格」という2つの入力欄が並び、片方だけ更新して実売価格が0円のまま
  // 残ってしまう事故があったための対応。色・サイズ等で価格が異なる複数バリエーションの
  // 商品には適用しない(過去に全バリエーション一括上書きのカスケードを廃止した経緯がある
  // ため、単一バリエーションの場合に限定する)。このPUTが同時にvariantsも更新する呼び出し
  // (現状のクライアントは基本情報とバリエーションを別々のリクエストで送るため該当しない)
  // では、明示的なvariants指定を優先しこのカスケードは行わない。
  await prisma.$transaction(async (tx) => {
    await tx.product.update({
      where: { id },
      data: {
        name: isNonEmptyString(name) ? name : undefined,
        description: description === undefined ? undefined : description,
        category: isNonEmptyString(category) ? category : undefined,
        itemType: itemType ?? undefined,
        salesModel: salesModel ?? undefined,
        basePrice: basePrice ?? undefined,
        status: status ?? undefined,
        images: normalizeImages(images),
        agencyAccessMode: agencyAccessMode ?? undefined,
        // sku同様、未指定(undefined)は既存値を維持し、明示的なnullでのみ解除できるようにする。
        agencyRole: agencyRole === undefined ? undefined : agencyRole,
        agencyProductCode: agencyProductCode === undefined ? undefined : agencyProductCode,
        agencyAccessExpiresDays: agencyAccessExpiresDays === undefined ? undefined : agencyAccessExpiresDays,
        agencyLoginRedirectPath: agencyLoginRedirectPath === undefined ? undefined : agencyLoginRedirectPath,
      },
    });

    if (variants === undefined && basePrice !== undefined) {
      const existingVariants = await tx.productVariant.findMany({ where: { productId: id }, select: { id: true } });
      if (existingVariants.length === 1) {
        await tx.productVariant.update({ where: { id: existingVariants[0].id }, data: { price: basePrice } });
      }
    }

    for (const v of updateEntries) {
      await tx.productVariant.update({
        where: { id: v.id },
        data: {
          name: v.name === undefined ? undefined : v.name,
          // Prismaはdata内のundefinedを「更新しない」として無視するため、未指定のsku(undefined)は
          // 既存値を維持し、明示的にnullを渡した場合のみ解除できる(仕様書外の拡張・2026-07-22指示書
          // Stage3)。旧実装は`v.sku ?? null`で未指定時も常にnullへ上書きしてしまい、管理画面の
          // 在庫だけ編集する操作のたびに既存SKUが消えていた。
          sku: v.sku,
          price: v.price === undefined ? undefined : v.price,
          stock: v.stock === undefined ? undefined : v.stock,
        },
      });
    }

    for (const v of createEntries) {
      await tx.productVariant.create({
        data: { productId: id, name: v.name, sku: v.sku ?? null, price: v.price, stock: v.stock ?? 0 },
      });
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
