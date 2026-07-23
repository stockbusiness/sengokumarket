// 仕様書外の拡張(保守性改善Phase 2): フロント・バックで別々に定義されていたロール定数を統一する。
// 調査時点で、代理店システム連携(agencies.ts)の「既にログインアカウントとして使われている
// roleの一覧」等、目的が異なる別概念のロール集合が別途存在することを確認済み。それらは意図的に
// ここへ統合しない(単純な重複ではなく、意味の異なる別の業務ルールのため)。
export const USER_ROLES = ['user', 'admin', 'admin_viewer', 'staff', 'agency'] as const;
export type UserRole = (typeof USER_ROLES)[number];

// 管理画面(/admin)へ入室できるロール。staffは日次業務系のみ利用可(個別機能の制限は
// FULL_ADMIN_ROLESで判定する)。
export const ADMIN_ROLES = ['admin', 'admin_viewer', 'staff'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

// 管理者・閲覧専用管理者のみ利用できる機能(紹介・代理店・クーポン・設定・法務・監査ログ・
// 管理者アカウント管理等)。
export const FULL_ADMIN_ROLES = ['admin', 'admin_viewer'] as const;
export type FullAdminRole = (typeof FULL_ADMIN_ROLES)[number];
