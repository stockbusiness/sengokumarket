import type { Order, OrderItem, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

// 購入後代理店システム連携実装指示書 6.4・6.5章: 決済確定(applyPaidOrderSideEffects)と
// 同一トランザクションでenqueueする。紹介コードの有無に関係なく、注文に含まれる商品の
// いずれかがagencyAccessMode!='none'であれば作成する。実際の外部HTTP送信はcommit後に
// Dispatcher(purchaseProvisioningDispatcher.ts)が行う。
export async function enqueueProvisioningJobIfEligible(tx: Tx, order: Order, orderItems: OrderItem[]): Promise<void> {
  const productIds = [...new Set(orderItems.map((item) => item.productId))];
  if (productIds.length === 0) return;

  const products = await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, agencyAccessMode: true } });
  const hasAgencyAccessProduct = products.some((p) => p.agencyAccessMode !== 'none');
  if (!hasAgencyAccessProduct) return;

  const deduplicationKey = `purchase-provisioning:${order.id}`;
  await tx.purchaseProvisioningJob.upsert({
    where: { deduplicationKey },
    create: { orderId: order.id, commonUserId: order.commonUserId, action: 'provision', deduplicationKey },
    update: {},
  });
  // orders.agency_provisioning_status(6.9章のキャッシュ)を'not_applicable'から進める。
  // 全額返金時、この値を見てrevokeジョブを送るべきかどうかを判断する
  // (enqueueProvisioningRevokeJobIfApplicable参照)。
  await tx.order.update({ where: { id: order.id }, data: { agencyProvisioningStatus: 'pending' } });
}

// 10章: 全額返金と同一トランザクションでenqueueする取消リクエスト。agencyAccessMode='none'の
// 商品のみの注文(そもそもprovisioningジョブを作っていない注文)まで無駄な行を作らないよう、
// orders.agency_provisioning_status(6.9章のキャッシュ)が'not_applicable'の場合はno-opにする。
export async function enqueueProvisioningRevokeJobIfApplicable(tx: Tx, order: Order): Promise<void> {
  if (order.agencyProvisioningStatus === 'not_applicable') return;

  const deduplicationKey = `purchase-provisioning-revoke:${order.id}`;
  await tx.purchaseProvisioningJob.upsert({
    where: { deduplicationKey },
    create: { orderId: order.id, commonUserId: order.commonUserId, action: 'revoke', deduplicationKey },
    update: {},
  });
}
