import { prisma } from '../../../lib/prisma';
import { HttpError } from '../../../lib/httpError';
import { appConfig } from '../../../shared/config/appConfig';
import { generateOrderNumber } from '../../../services/orderNumber';
import { resolveReferral, resolveReferralByAttribution } from '../../../services/referral';
import { matchExplainerName } from '../../../services/explainerMatch';
import * as checkoutItemRepo from '../infrastructure/checkoutItem.repository';
import * as purchaserRepo from '../infrastructure/purchaserAccount.repository';
import * as orderWriter from '../infrastructure/orderWriter.repository';
import * as couponAdapter from '../infrastructure/couponReservation.adapter';
import { enqueueCommonUserResolveJob, enqueueReferralCaptureJob } from '../../../services/orderLinkingJobs';
import { assertStockAvailable } from '../domain/stockAvailability.policy';
import { assertAgentRequiredSatisfied } from '../domain/salesModel.policy';
import { calculateOriginalAmount } from '../domain/orderPricing.service';
import type { CreatePendingOrderInput, CreatePendingOrderResult } from '../domain/checkout.types';

// 指示書9.4「トランザクション境界」: このUseCaseの外側(このファイル内)で単一のPrismaトランザクションを
// 維持し、内部で呼び出す各repository/adapterは独自にトランザクションを開始しない。
export async function createPendingOrder(input: CreatePendingOrderInput): Promise<CreatePendingOrderResult> {
  const termsVersion = appConfig.termsVersion;
  if (!termsVersion) throw new HttpError(500, 'CONFIG_ERROR', 'TERMS_VERSIONが設定されていません');

  // ロック順序を揃えてデッドロックを防ぐ
  const sortedVariantIds = [...new Set(input.items.map((i) => i.variantId))].sort();

  return prisma.$transaction(async (tx) => {
    const rowByVariantId = await checkoutItemRepo.lockVariantsForCheckout(tx, sortedVariantIds);

    assertStockAvailable(input.items, rowByVariantId);
    await checkoutItemRepo.reserveStock(tx, input.items);

    const purchaserResolution = await purchaserRepo.resolveOrCreatePurchaser(tx, input);
    let user = purchaserResolution.user;
    const guestAccountCreated = purchaserResolution.guestAccountCreated;

    // 仕様書外の拡張: 代理店への帰属は初回購入時点で永久固定(以降どの紹介コードでアクセスしても変わらない)
    let referral;
    if (user.referredByAgencyId || user.referredByInfluencerId || user.referredByReferralLinkId) {
      referral = await resolveReferralByAttribution(tx, {
        agencyId: user.referredByAgencyId,
        influencerId: user.referredByInfluencerId,
        referralLinkId: user.referredByReferralLinkId,
        code: user.referredByCode,
      });
    } else {
      referral = await resolveReferral(tx, input.referralCode);
      if (referral.agencyId || referral.influencerId || referral.referralLinkId) {
        user = await purchaserRepo.attachReferralAttribution(tx, user.id, {
          agencyId: referral.agencyId,
          influencerId: referral.influencerId,
          referralLinkId: referral.referralLinkId,
          referralCode: referral.referralCode,
        });
      }
    }

    assertAgentRequiredSatisfied(input.items, rowByVariantId, referral);

    const orderNumber = await generateOrderNumber(tx);
    const originalAmount = calculateOriginalAmount(input.items, rowByVariantId);

    // 仕様書外の拡張: 紹介コードの持ち主とは別に、購入者に商品を説明した担当者名を記録する
    // (報酬計算には使わない。名簿と一致すればIDも記録、一致しなくても購入は継続する)。
    const explainerMatch = await matchExplainerName(tx, input.explainerName);

    let order = await orderWriter.createOrder(tx, {
      orderNumber,
      userId: user.id,
      totalAmount: originalAmount,
      originalAmount,
      paymentMethod: input.paymentMethod ?? 'stripe',
      referralCode: referral.referralCode,
      referrerName: referral.referrerName,
      agencyName: referral.agencyName,
      agencyId: referral.agencyId,
      influencerId: referral.influencerId,
      referralLinkId: referral.referralLinkId,
      commissionRate: referral.commissionRate,
      agencyHierarchy: referral.agencyHierarchy,
      explainerName: input.explainerName ?? null,
      explainerAgencyId: explainerMatch.agencyId,
      explainerInfluencerId: explainerMatch.influencerId,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      customerPostalCode: input.customerPostalCode,
      customerAddress: input.customerAddress,
      termsVersion,
      guestAccountCreated,
    });

    const items = await orderWriter.createOrderItems(
      tx,
      order.id,
      input.items.map((item) => {
        const row = rowByVariantId.get(item.variantId)!;
        return {
          variantId: item.variantId,
          productId: row.productId,
          productName: row.productName,
          variantName: row.variantName,
          itemType: row.itemType,
          quantity: item.quantity,
          unitPrice: row.price,
        };
      }),
    );

    // 仕様書外の拡張(クーポン機能): 手入力クーポンが指定されていればそれを優先し、
    // なければ紹介リンクに設定された自動適用クーポンを使う。
    const isManualCoupon = Boolean(input.couponCode);
    const effectiveCouponCode = input.couponCode ?? (referral.couponAutoApply ? referral.couponCode : null);

    if (effectiveCouponCode) {
      const reserve = () =>
        couponAdapter.reserveCoupon(tx, {
          code: effectiveCouponCode,
          userId: user.id,
          agencyId: referral.agencyId,
          items: items.map((i) => ({ productId: i.productId, subtotal: i.subtotal })),
          orderId: order.id,
        });

      // 手入力クーポンの検証失敗は購入者に見えるエラーとして中断する。自動適用クーポンの
      // 検証失敗(運用上の設定不備等)は購入自体を止めず、通常価格で購入を継続させる。
      const pricing = isManualCoupon ? await reserve() : await reserve().catch(() => null);

      if (pricing) {
        order = await orderWriter.applyCouponPricing(tx, order.id, {
          finalAmount: pricing.finalAmount,
          discountAmount: pricing.discountAmount,
          couponId: pricing.coupon.id,
          couponCode: pricing.coupon.code,
        });
      }
    }

    // 仕様書外の拡張(千ノ国全体連携・残課題指示書Stage4): common_user_id解決・referral captureは
    // 外部HTTP呼び出しを伴うため、注文作成トランザクション内では永続ジョブとして記録するのみに
    // とどめる(Serverlessのレスポンス完了後に処理が打ち切られてもジョブを失わないため)。
    // 実際の送信はcommit後にDispatcherがベストエフォートで行う。referral confirmは
    // 決済確定タイミングで別途enqueueする(Stage5)。
    await enqueueCommonUserResolveJob(tx, { userId: user.id, orderId: order.id });
    if (order.referralCode) {
      await enqueueReferralCaptureJob(tx, order.id);
    }

    return { order, items };
  });
}
