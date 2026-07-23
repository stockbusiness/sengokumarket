// Domain Policy/Applicationが共有する代理店の型。Prisma・Expressに依存しない。

export interface AgencyRecord {
  id: string;
  externalId: string | null;
  name: string;
  code: string;
  status: string;
  defaultCommissionRate: number;
  contactName: string | null;
  contactEmail: string | null;
  // 親が未解決(先方仕様書v3.6.40)の間は、受け取ったexternal_idをそのまま返す。
  parentExternalId: string | null;
}

export interface AgencyDetail extends AgencyRecord {
  childExternalIds: string[];
}

export interface UpsertAgencyRequest {
  externalId: string;
  name: string;
  // undefined = 未指定(現状維持)、null/'' = 本部直下への明示的な解除、文字列 = external_id指定。
  parentExternalId?: string | null;
  defaultCommissionRate?: number | null;
  contactName?: string | null;
  contactEmail?: string | null;
  status?: 'active' | 'inactive';
  loginEmail?: string | null;
}

// 新規ログインユーザー作成時は設定リンク用トークンの発行(パスワード再設定サービス経由)が
// トランザクション外で必要になるため、userIdのみを持たせてトークン発行を後段に委ねる。
export type AgencyNotification =
  | { type: 'access_granted'; email: string; name: string }
  | { type: 'setup_required'; email: string; name: string; userId: string };

export class AgencyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgencyValidationError';
  }
}

// 既に管理者・代理店ログインとして使われているメールアドレスをlogin_emailに指定した場合。
export class AgencyLoginConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgencyLoginConflictError';
  }
}
