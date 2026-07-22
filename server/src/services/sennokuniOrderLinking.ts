import { prisma } from '../lib/prisma';
import { isSennokuniIntegrationEnabled } from './sennokuniIntegrationConfig';
import { resolveCommonUserId } from './externalCommonUserClient';
import { captureReferralToken, confirmReferral } from './externalReferralClient';

// 仕様書外の拡張(千ノ国全体連携 共通インターフェース契約v1.1 DRAFT・2026-07-22指示書対応):
// common_user_id解決→referral capture/confirmを順番に実行し、注文へ代理店4役をスナップショットする
// オーケストレーター。checkout.tsのDBトランザクション完了「後」に、レスポンスをブロックしない形
// (fire-and-forget)で1回だけ呼ぶこと。Feature Flag無効時(既定)は即座に何もせず、既存の決済・
// 紹介・報酬フローには一切影響しない。
//
// 変更禁止範囲(CLAUDE.md・2026-07-22指示書3章): 既存のorders.agencyId/influencerId(このDB内の
// UUID・報酬計算対象)は一切更新しない。ここで更新するのはregistration_referrer_agency_id等の
// 外部agent_code用カラムのみであり、報酬計算(commissions)には影響させない。
export async function runBestEffortSennokuniOrderLinking(orderId: string): Promise<void> {
  if (!isSennokuniIntegrationEnabled()) return;

  try {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    let commonUserId: string | null = null;
    if (order.userId) {
      const user = await prisma.user.findUnique({ where: { id: order.userId } });
      commonUserId = user?.commonUserId ?? null;
      if (!commonUserId) {
        const resolved = await resolveCommonUserId({ externalUserId: order.userId, verifiedEmail: order.customerEmail });
        if (resolved) {
          commonUserId = resolved.commonUserId;
          await prisma.user.update({ where: { id: order.userId }, data: { commonUserId } });
        }
      }
    }

    if (!order.referralCode) {
      if (commonUserId) {
        await prisma.order.update({ where: { id: orderId }, data: { commonUserId, commonUserResolutionStatus: 'resolved' } });
      }
      return;
    }

    const captured = await captureReferralToken(order.referralCode);
    if (!captured) return;

    if (!commonUserId) {
      // common_user_idが未解決のままではreferral confirmできない(契約書5章)。
      // referral_session_keyだけは記録し、担当者4役の確定は後続処理に委ねる。
      await prisma.order.update({ where: { id: orderId }, data: { referralSessionKey: captured.referralSessionKey } });
      return;
    }

    const confirmed = await confirmReferral({
      referralSessionKey: captured.referralSessionKey,
      commonUserId,
      event: 'purchase',
    });

    await prisma.order.update({
      where: { id: orderId },
      data: {
        commonUserId,
        commonUserResolutionStatus: 'resolved',
        referralSessionKey: captured.referralSessionKey,
        registrationReferrerAgentCode: confirmed?.registrationReferrerAgencyId ?? undefined,
        assignedAgentCode: confirmed?.assignedAgencyId ?? undefined,
        salesAgentCode: confirmed?.salesAgentId ?? undefined,
        closingAgentCode: confirmed?.closingAgentId ?? undefined,
      },
    });
  } catch (e) {
    console.error('sennokuni order linking best-effort failed', { orderId, error: e });
  }
}
