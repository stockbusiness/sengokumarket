export const ITEM_TYPES = ['nft', 'physical', 'service', 'membership', 'fee'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const PRODUCT_STATUSES = ['draft', 'published', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

// 仕様書外の拡張(千ノ国5システム共通方針書v3.0 15章): 商品ごとの販売方式。
export const SALES_MODELS = ['direct_allowed', 'agent_required', 'hybrid'] as const;
export type SalesModel = (typeof SALES_MODELS)[number];

// 購入後代理店システム連携実装指示書 3.2・6.3章: 商品ごとの代理店ポータルアクセス権限。
// none = 連携なし(既定), customer_portal = 一般利用者ログイン権限, agent_portal = 代理店・
// アドバイザー業務ログイン権限(agencyRole・agencyProductCodeが必須)。
export const AGENCY_ACCESS_MODES = ['none', 'customer_portal', 'agent_portal'] as const;
export type AgencyAccessMode = (typeof AGENCY_ACCESS_MODES)[number];
