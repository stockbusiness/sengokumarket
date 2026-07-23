import { prisma } from '../../../lib/prisma';
import { cancelCouponUsage } from '../../../services/coupon';
import { releaseStock } from '../infrastructure/checkoutItem.repository';

// Stripe Checkout Session作成に失敗した場合の補償処理。
// 仮引当した在庫を解放し、注文は決済不可として扱う(再度カートからやり直してもらう)。
export async function cancelOrderReservation(orderId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.paymentStatus !== 'pending') return;

    const items = await tx.orderItem.findMany({ where: { orderId } });
    const stockBackedItems = items
      .filter((item): item is typeof item & { variantId: string } => item.variantId !== null)
      .map((item) => ({ variantId: item.variantId, quantity: item.quantity }));
    await releaseStock(tx, stockBackedItems);

    await cancelCouponUsage(tx, orderId);
    await tx.order.update({ where: { id: orderId }, data: { paymentStatus: 'failed' } });
  });
}
