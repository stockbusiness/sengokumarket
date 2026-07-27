// 起動必須の環境変数(指示書10.1・残課題指示書Stage1)。Stripe/Resend/外部代理店システム等の
// 秘密情報はDB(settingsテーブル、services/settings.ts)で暗号化管理するため、ここには含めない
// (CLAUDE.md「環境変数」章・.env.example参照)。
const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'APP_URL',
  'TERMS_VERSION',
  'SETTINGS_ENCRYPTION_KEY',
  'RATE_LIMIT_HASH_SECRET',
] as const;

const MIN_JWT_SECRET_LENGTH = 32;
// 既知のプレースホルダー・デフォルト値をそのまま本番で使ってしまう事故を防ぐ(小文字比較)。
const KNOWN_DEFAULT_JWT_SECRETS = new Set(['secret', 'changeme', 'change-me', 'your-secret-key', 'test', 'password', 'jwt-secret']);
const HEX64_RE = /^[0-9a-fA-F]{64}$/;
// 本番安定化指示書Stage3(6.3「identifier保護」)向け: レート制限bucket_keyへメールアドレス・
// クーポンコード・紹介コード等を平文で保存しないためのHMAC鍵。JWT_SECRETと同じ最小長・
// 既知デフォルト値チェックを適用する。
const MIN_RATE_LIMIT_HASH_SECRET_LENGTH = 32;

// 各検証は「不正である」ことだけを変数名と共に返し、実際の値(秘密情報を含みうる)は
// 一切メッセージへ含めない(残課題指示書Stage1「エラーに秘密値そのものを出力しない」)。
function validateAppUrl(value: string, isProduction: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'APP_URLは有効な絶対URLではありません';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'APP_URLはhttp/https以外のプロトコルです';
  }
  if (isProduction && url.protocol !== 'https:') {
    return 'APP_URLは本番環境ではhttps:である必要があります';
  }
  return null;
}

function validateJwtSecret(value: string): string | null {
  if (value.length < MIN_JWT_SECRET_LENGTH) {
    return `JWT_SECRETは${MIN_JWT_SECRET_LENGTH}文字以上である必要があります`;
  }
  if (KNOWN_DEFAULT_JWT_SECRETS.has(value.toLowerCase())) {
    return 'JWT_SECRETに既知のデフォルト値が設定されています';
  }
  return null;
}

function validateSettingsEncryptionKey(value: string): string | null {
  if (!HEX64_RE.test(value)) {
    return 'SETTINGS_ENCRYPTION_KEYは64文字の16進数文字列(32byte相当)である必要があります';
  }
  return null;
}

function validateDatabaseUrl(value: string): string | null {
  if (!value.startsWith('postgres://') && !value.startsWith('postgresql://')) {
    return 'DATABASE_URLはpostgres://またはpostgresql://で始まる接続文字列である必要があります';
  }
  return null;
}

function validateTermsVersion(value: string): string | null {
  return value.trim().length === 0 ? 'TERMS_VERSIONを空文字にすることはできません' : null;
}

function validateRateLimitHashSecret(value: string): string | null {
  if (value.length < MIN_RATE_LIMIT_HASH_SECRET_LENGTH) {
    return `RATE_LIMIT_HASH_SECRETは${MIN_RATE_LIMIT_HASH_SECRET_LENGTH}文字以上である必要があります`;
  }
  if (KNOWN_DEFAULT_JWT_SECRETS.has(value.toLowerCase())) {
    return 'RATE_LIMIT_HASH_SECRETに既知のデフォルト値が設定されています';
  }
  return null;
}

// CI復旧・本番移行前最終指示書 Stage4「Notification Token本番必須化」: この鍵が未設定・
// 短すぎる間は決定論的Token発行が都度ランダム発行へフォールバックし、retry時にClaim URL・
// 設定URLが無効化される問題(最終安定化指示書Phase2で対処済みの前提)が再発しうる。
// productionでのみ必須にする(ローカル・test環境は既存のフォールバックを許可する)。
const MIN_NOTIFICATION_TOKEN_DERIVATION_SECRET_BYTES = 32;

function validateNotificationTokenDerivationSecretForProduction(value: string | undefined, isProduction: boolean): string | null {
  if (!isProduction) return null;
  if (!value) {
    return 'NOTIFICATION_TOKEN_DERIVATION_SECRETが未設定です(production環境では必須)';
  }
  if (Buffer.byteLength(value, 'utf8') < MIN_NOTIFICATION_TOKEN_DERIVATION_SECRET_BYTES) {
    return `NOTIFICATION_TOKEN_DERIVATION_SECRETは${MIN_NOTIFICATION_TOKEN_DERIVATION_SECRET_BYTES}byte以上である必要があります`;
  }
  if (KNOWN_DEFAULT_JWT_SECRETS.has(value.toLowerCase())) {
    return 'NOTIFICATION_TOKEN_DERIVATION_SECRETに既知のデフォルト値が設定されています';
  }
  return null;
}

// 本番安定化指示書Stage0(/api/ready)向け: プロセスを落とさずに検証結果だけを得たい
// 呼び出し元のために、assertRequiredEnvから例外送出を分離した非throw版。
export function collectRequiredEnvErrors(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing = REQUIRED_ENV_VARS.filter((key) => !env[key]);
  if (missing.length > 0) {
    return [`必須環境変数が設定されていません: ${missing.join(', ')}`];
  }

  const isProduction = env.NODE_ENV === 'production';
  return [
    validateAppUrl(env.APP_URL!, isProduction),
    validateJwtSecret(env.JWT_SECRET!),
    validateSettingsEncryptionKey(env.SETTINGS_ENCRYPTION_KEY!),
    validateDatabaseUrl(env.DATABASE_URL!),
    validateTermsVersion(env.TERMS_VERSION!),
    validateRateLimitHashSecret(env.RATE_LIMIT_HASH_SECRET!),
    validateNotificationTokenDerivationSecretForProduction(env.NOTIFICATION_TOKEN_DERIVATION_SECRET, isProduction),
  ].filter((e): e is string => e !== null);
}

// サーバー起動時(index.ts・Vercelエントリポイントのapi/index.ts)にのみ呼び出す。createApp()
// 自体からは呼ばない(createApp()は各テストファイルからも直接呼ばれるため、テスト環境固有の
// 緩い設定でも動作できるようにするため)。
export function assertRequiredEnv(env: NodeJS.ProcessEnv = process.env): void {
  const errors = collectRequiredEnvErrors(env);
  if (errors.length > 0) {
    throw new Error(`環境変数の設定が不正です: ${errors.join(' / ')}`);
  }
}
