// 仕様書外の拡張: 価格入力を税込/税別のどちらでも受け付けられるようにする。
// 保存される金額(basePrice/variant.price)は常に実際の決済金額(税込)であり、
// この変換はあくまで入力時の利便性のためのもの(仕様書v1.5 コーディング規約「金額は
// すべてINTEGER(円)」を維持し、税別入力時は税込金額に変換してから送信する)。
export const ITEM_TYPES = ['nft', 'physical', 'service', 'membership', 'fee'];
export const STATUSES = ['draft', 'published', 'archived'];
// 仕様書外の拡張(千ノ国5システム共通方針書v3.0 15章): 商品ごとの販売方式。
export const SALES_MODELS = ['direct_allowed', 'agent_required', 'hybrid'] as const;
export const SALES_MODEL_LABELS: Record<string, string> = {
  direct_allowed: '直販可能(代理店なしで購入可)',
  agent_required: '代理店経由必須(担当代理店確定が必要)',
  hybrid: '直販・代理店経由の併用',
};
export const TAX_RATE = 0.1;
export type PriceMode = 'included' | 'excluded';

export function toTaxIncluded(amount: number, mode: PriceMode): number {
  return mode === 'excluded' ? Math.floor(amount * (1 + TAX_RATE)) : amount;
}

// 税込価格から税別価格の目安を逆算する(モード切替時に入力欄の表示を作り直すためだけに使う。
// 保存処理では使わない)。
export function toTaxExcludedEstimate(amount: number): number {
  return Math.round(amount / (1 + TAX_RATE));
}

export interface VariantRow {
  name: string;
  stock: number;
}
export const DEFAULT_VARIANT_ROWS: VariantRow[] = [{ name: '通常', stock: 0 }];
