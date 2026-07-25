import type { Order, OrderItem, Prisma } from '@prisma/client';
import { createPasswordResetToken } from './passwordReset';
import { sendGuestPasswordSetupEmail, sendPurchaseCompleteEmail } from './mailTemplates';
import { confirmCouponUsage } from './coupon';
import { getNftChain } from './nftMint';
import { enqueueEntitlementEvents } from './integrationOutbox';
import { enqueueReferralConfirmPurchaseJob } from './orderLinkingJobs';
import { isWalletClaimEnabled } from './walletClaimConfig';
import { getDigitalCollectibleRule, incrementProductSerialCounter } from './digitalCollectible';
import { createWalletClaimIfEligible } from './walletClaim';

type Tx = Prisma.TransactionClient;

// 決済確定時の共通処理(Stripe Webhook・銀行振込の手動確認の両方から呼ばれる)。
// 呼び出し元は、決済手段固有のカラム(stripeSessionId等)を含めて先にorders.paymentStatus='paid'への
// 更新を済ませたうえで、その更新後のorderを渡すこと。

// order_items.item_type = 'nft' の行のみ、quantity個ぶん個別レコードを作成する(仕様書v1.5 6.7 / 7.2)
export async function createNftIssuesForOrder(tx: Tx, orderId: string, userId: string | null) {
  const orderItems = await tx.orderItem.findMany({ where: { orderId, itemType: 'nft' } });
  if (orderItems.length === 0) return;

  const wallet = userId ? await tx.wallet.findUnique({ where: { userId } }) : null;
  // 仕様書外の拡張: 署名検証(verified)を通過したウォレットのみready_to_issueへ即時遷移する。
  const hasVerifiedWallet = Boolean(wallet?.verified);

  for (const item of orderItems) {
    // 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)12章: digital_collectible対象の
    // 商品のみ、マーケット側で不変のシリアル番号を発番する(既存の他NFT商品はnullのまま。
    // 引き続きnftMintProcessing.tsが従来通りベストエフォートで別途採番する)。
    const digitalCollectibleRule = isWalletClaimEnabled() ? await getDigitalCollectibleRule(tx, item.productId) : null;

    const rows: Prisma.NftIssueCreateManyInput[] = [];
    for (let i = 0; i < item.quantity; i += 1) {
      const serialNumber = digitalCollectibleRule ? await incrementProductSerialCounter(tx, item.productId) : null;
      // 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)17章「自動Mint対象外」:
      // digital_collectible対象商品は、検証済みウォレットを持つ購入者でもready_to_issueへ
      // 自動遷移させない(MVPでは自動Mintしない方針)。カード送付はWalletClaim/
      // CollectibleDeliveryの経路で行われ、この行のwalletAddress/statusは使わない。
      const readyToIssue = hasVerifiedWallet && !digitalCollectibleRule;
      rows.push({
        orderId,
        orderItemId: item.id,
        userId,
        productId: item.productId,
        variantId: item.variantId,
        status: readyToIssue ? 'ready_to_issue' : 'wallet_required',
        walletAddress: readyToIssue ? wallet!.walletAddress : null,
        // 仕様書外の拡張: 発行対象チェーンはNFT_CHAIN環境変数を唯一の参照元にする(コード固定しない)。
        chain: getNftChain(),
        serialNumber,
      });
    }
    await tx.nftIssue.createMany({ data: rows });
  }
}

// referral_link_idがある注文のみcommissionsを作成する。0円はstatus=cancelledで作成(追跡用)。仕様書v1.5 6.14
export async function createCommissionForOrder(tx: Tx, order: Order) {
  if (!order.referralLinkId) return;

  const commissionRate = Number(order.commissionRate);
  const commissionAmount = Math.round((order.totalAmount * commissionRate) / 100);
  const status = commissionRate > 0 ? 'pending' : 'cancelled';

  await tx.commission.create({
    data: {
      orderId: order.id,
      agencyId: order.agencyId,
      influencerId: order.influencerId,
      referralCode: order.referralCode,
      baseAmount: order.totalAmount,
      commissionRate,
      commissionAmount,
      status,
    },
  });

  await tx.order.update({
    where: { id: order.id },
    data: { commissionAmount, commissionStatus: status },
  });
}

// paymentStatus='paid'への更新後に呼ぶ: 在庫確定・NFT発行キュー作成・報酬計算をまとめて行う。
export async function applyPaidOrderSideEffects(tx: Tx, order: Order) {
  const orderItems = await tx.orderItem.findMany({ where: { orderId: order.id } });
  for (const item of orderItems) {
    if (!item.variantId) continue;
    await tx.productVariant.update({
      where: { id: item.variantId },
      data: { stock: { decrement: item.quantity }, reservedStock: { decrement: item.quantity } },
    });
  }

  await createNftIssuesForOrder(tx, order.id, order.userId);
  await createCommissionForOrder(tx, order);
  // 仕様書外の拡張(クーポン機能): reserved→usedへの確定。Stripe・銀行振込どちらの
  // 決済手段でもこの関数を通るため、ここに1箇所追加するだけで両方に対応できる。
  await confirmCouponUsage(tx, order.id);
  // 仕様書外の拡張(千ノ国全体統合契約2026-07-21 6章): 決済確定と同一トランザクションで
  // entitlement.grantedをOutboxへ記録する(送信先ルール未設定の商品はno-op)。
  await enqueueEntitlementEvents(tx, order, orderItems, 'entitlement.granted');
  // 仕様書外の拡張(残課題指示書Stage5): referral confirm(event=purchase)は決済確定前に
  // 送ってしまうと未決済・離脱注文まで購入扱いになってしまうため、Checkout時点では送らず、
  // 決済確定と同一トランザクションでジョブとして記録する(実送信はcommit後にDispatcherが行う)。
  if (order.referralCode) {
    await enqueueReferralConfirmPurchaseJob(tx, order.id);
  }

  // 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)4章: `paymentStatus=paid`確定と
  // 同一トランザクションでWalletClaimを作成する。生トークンはこの1回しか取得できないため、
  // 呼び出し元がsendPostPaymentEmailsへ引き渡して受取URLをメールへ含める。
  const walletClaimToken = await createWalletClaimIfEligible(tx, order, orderItems);

  return { order, items: orderItems, walletClaimToken };
}

// メール送信はトランザクション外で行い、失敗しても決済確定処理自体は失敗させない(仕様書v1.5 7.2 手順8 / 7.6)。
export async function sendPostPaymentEmails(order: Order, items: OrderItem[], walletClaimToken?: string | null) {
  try {
    await sendPurchaseCompleteEmail(order, items, walletClaimToken ?? null);

    if (order.guestAccountCreated && order.userId) {
      const token = await createPasswordResetToken(order.userId);
      await sendGuestPasswordSetupEmail(order.customerEmail, order.customerName, token);
    }
  } catch (e) {
    console.error('post-payment email dispatch failed', { orderId: order.id, error: e });
  }
}
