import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/apiError';
import { requireReferralOrAuth } from '../middleware/referralAccess';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serializeVariant(variant: { id: string; name: string; price: number; stock: number; reservedStock: number }) {
  return {
    id: variant.id,
    name: variant.name,
    price: variant.price,
    availableStock: Math.max(variant.stock - variant.reservedStock, 0),
  };
}

router.get('/products', requireReferralOrAuth, async (_req, res) => {
  const products = await prisma.product.findMany({
    where: { status: 'published' },
    include: { variants: true },
    orderBy: { createdAt: 'asc' },
  });

  res.json({
    products: products.map((product) => ({
      id: product.id,
      slug: product.slug,
      name: product.name,
      category: product.category,
      basePrice: product.basePrice,
      imageUrl: product.imageUrl,
      variants: product.variants.map(serializeVariant),
    })),
  });
});

router.get('/products/:idOrSlug', requireReferralOrAuth, async (req, res) => {
  const { idOrSlug } = req.params;
  const product = await prisma.product.findFirst({
    where: UUID_RE.test(idOrSlug) ? { id: idOrSlug, status: 'published' } : { slug: idOrSlug, status: 'published' },
    include: { variants: true },
  });

  if (!product) {
    return sendError(res, 404, 'PRODUCT_NOT_FOUND', '商品が見つかりません');
  }

  res.json({
    product: {
      id: product.id,
      slug: product.slug,
      name: product.name,
      description: product.description,
      category: product.category,
      basePrice: product.basePrice,
      imageUrl: product.imageUrl,
      variants: product.variants.map(serializeVariant),
    },
  });
});

export default router;
