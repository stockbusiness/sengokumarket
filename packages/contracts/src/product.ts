export const ITEM_TYPES = ['nft', 'physical', 'service', 'membership', 'fee'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const PRODUCT_STATUSES = ['draft', 'published', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

// 仕様書外の拡張(千ノ国5システム共通方針書v3.0 15章): 商品ごとの販売方式。
export const SALES_MODELS = ['direct_allowed', 'agent_required', 'hybrid'] as const;
export type SalesModel = (typeof SALES_MODELS)[number];
