// 起動必須の環境変数(指示書10.1)。Stripe/Resend/外部代理店システム等の秘密情報は
// DB(settingsテーブル、services/settings.ts)で暗号化管理するため、ここには含めない
// (CLAUDE.md「環境変数」章・.env.example参照)。
const REQUIRED_ENV_VARS = ['DATABASE_URL', 'JWT_SECRET', 'APP_URL', 'TERMS_VERSION', 'SETTINGS_ENCRYPTION_KEY'] as const;

// サーバー起動時(index.ts)にのみ呼び出す。createApp()自体からは呼ばない
// (createApp()は各テストファイルからも直接呼ばれるため、テスト環境固有の緩い設定でも
// 動作できるようにするため)。
export function assertRequiredEnv(env: NodeJS.ProcessEnv = process.env): void {
  const missing = REQUIRED_ENV_VARS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`必須環境変数が設定されていません: ${missing.join(', ')}`);
  }
}
