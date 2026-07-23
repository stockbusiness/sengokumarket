import { HttpError } from '../../../lib/httpError';
import type { CheckoutItemInput, CheckoutVariantRow } from './checkout.types';

interface ReferralAttributionForSalesModel {
  agencyId: string | null;
  influencerId: string | null;
}

// 仕様書外の拡張(千ノ国5システム共通方針書v3.0 15.2): sales_model=agent_requiredの商品は、
// 販売担当代理店(または紹介インフルエンサー)が確定していない注文を確定させない。
export function assertAgentRequiredSatisfied(
  items: CheckoutItemInput[],
  rowByVariantId: Map<string, CheckoutVariantRow>,
  referral: ReferralAttributionForSalesModel,
): void {
  const agentRequiredItem = items.find((item) => rowByVariantId.get(item.variantId)!.salesModel === 'agent_required');
  if (agentRequiredItem && !referral.agencyId && !referral.influencerId) {
    const row = rowByVariantId.get(agentRequiredItem.variantId)!;
    throw new HttpError(
      400,
      'AGENT_REQUIRED',
      `「${row.productName}」のご購入には担当代理店の確認が必要です。担当代理店にご相談のうえ、ご案内の購入用リンクからお進みください`,
    );
  }
}
