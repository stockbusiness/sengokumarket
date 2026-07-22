const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

// 仕様書外の拡張: メールアドレスは大文字小文字を区別しない一般的な運用に合わせ、保存前に
// 正規化する(User@example.comとuser@example.comを別アカウントにしない)。既存データは
// 混在したまま残るため、検索側は`emailFilterInsensitive`で大文字小文字を無視して照合する。
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// 大文字小文字を区別せずメールアドレスを検索するためのPrismaフィルタ。findUnique(一意制約)は
// フィルタオブジェクトを受け付けないため、この値を使う箇所はfindFirstを使うこと。
export function emailFilterInsensitive(email: string) {
  return { equals: normalizeEmail(email), mode: 'insensitive' as const };
}
