// 仕様書外の拡張(保守性改善Phase 1): 機能別ファイル(client/src/features/admin-*/api.ts)への
// 分割に伴い、既存の import 元(`../../lib/adminApi`)を変更せずに済むよう、このファイルは
// re-exportのみを行う互換シムとして維持する。新規コードはfeatures配下から直接importすること。
export * from '../features/admin-dashboard/api';
export * from '../features/admin-products/api';
export * from '../features/admin-orders/api';
export * from '../features/admin-nft-issues/api';
export * from '../features/admin-wallet-missing/api';
export * from '../features/admin-notices/api';
export * from '../features/admin-agencies/api';
export * from '../features/admin-referrals/api';
export * from '../features/admin-settings/api';
export * from '../features/admin-import-products/api';
export * from '../features/admin-external-orders/api';
export * from '../features/admin-legal/api';
export * from '../features/admin-audit-logs/api';
export * from '../features/admin-users/api';
export * from '../features/admin-coupons/api';
