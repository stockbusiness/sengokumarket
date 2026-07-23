// 仕様書外の拡張(保守性改善Phase 1): 権限判定をNavBar・Route Guard・Layoutで別々に
// 実装すると定義が重複・不整合になる(実際に staff は RequireAdmin では管理画面へ入れるが、
// 旧NavBarのリンク表示条件には含まれていなかった)。この1ファイルを唯一の定義元とする。

export const ADMIN_ACCESS_ROLES = ['admin', 'admin_viewer', 'staff'] as const;
export const FULL_ADMIN_ROLES = ['admin', 'admin_viewer'] as const;

// 管理画面(/admin)へ入室できる(ダッシュボード・商品・注文等の日次業務系のみ利用可能な
// staffを含む)。個別機能ごとの制限(紹介リンク発行等)はcanAccessFullAdminで判定する。
export function canAccessAdmin(role: string | undefined | null): boolean {
  return !!role && (ADMIN_ACCESS_ROLES as readonly string[]).includes(role);
}

// 管理者・閲覧専用管理者のみ利用できる機能(紹介・代理店・クーポン・設定・法務・監査ログ・
// 管理者アカウント管理)。staffはここではfalseになる。
export function canAccessFullAdmin(role: string | undefined | null): boolean {
  return !!role && (FULL_ADMIN_ROLES as readonly string[]).includes(role);
}

export function canAccessAgencyPortal(role: string | undefined | null): boolean {
  return role === 'agency';
}
