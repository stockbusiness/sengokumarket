import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/apiError';

const router = Router();

interface ValidateRequestItem {
  variantId: string;
  quantity: number;
}

router.post('/cart/validate', async (req, res) => {
  const items: ValidateRequestItem[] = Array.isArray(req.body?.items) ? req.body.items : [];

  if (
    items.length === 0 ||
    items.some((item) => typeof item.variantId !== 'string' || !Number.isInteger(item.quantity) || item.quantity < 1)
  ) {
    return sendError(res, 400, 'INVALID_CART_ITEMS', 'カートの内容が不正です');
  }

  const variants = await prisma.productVariant.findMany({
    where: { id: { in: items.map((item) => item.variantId) } },
    include: { product: true },
  });
  const variantById = new Map(variants.map((v) => [v.id, v]));

  let valid = true;
  const resultItems = items.map((item) => {
    const variant = variantById.get(item.variantId);

    if (!variant || variant.product.status !== 'published') {
      valid = false;
      return {
        variantId: item.variantId,
        found: false,
        requestedQuantity: item.quantity,
      };
    }

    const availableStock = Math.max(variant.stock - variant.reservedStock, 0);
    const stockInsufficient = availableStock < item.quantity;
    if (stockInsufficient) valid = false;

    return {
      variantId: variant.id,
      found: true,
      productId: variant.productId,
      productSlug: variant.product.slug,
      productName: variant.product.name,
      variantName: variant.name,
      price: variant.price,
      availableStock,
      requestedQuantity: item.quantity,
      stockInsufficient,
    };
  });

  res.json({ valid, items: resultItems });
});

export default router;
