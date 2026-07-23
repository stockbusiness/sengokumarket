// アプリ全体で使う非秘密の設定値。process.envの直接参照をここへ段階的に集約する
// (指示書10.3「process.envの直接参照を段階的に削減」)。既存の呼び出し元をすべて
// 一度に置き換えるのではなく、まずはappConfig自体を整備し、以降の新規・改修箇所から
// 順にこちらを参照する方針とする。
export const appConfig = {
  get appUrl(): string | undefined {
    return process.env.APP_URL;
  },
  get termsVersion(): string | undefined {
    return process.env.TERMS_VERSION;
  },
  get port(): number {
    return process.env.PORT ? Number(process.env.PORT) : 4000;
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  },
  get jwtSecret(): string | undefined {
    return process.env.JWT_SECRET;
  },
  get settingsEncryptionKeyHex(): string | undefined {
    return process.env.SETTINGS_ENCRYPTION_KEY;
  },
  get cronSecret(): string | undefined {
    return process.env.CRON_SECRET;
  },
  // 仕様書外の拡張(指示書12.2「ブランド名のConfig化」): 通知メール件名等で使うブランド表記。
  // 現時点では環境変数化しておらず(変更頻度が低いため)、この1箇所のみを変更点とする。
  get brandName(): string {
    return '戦国楽市楽座';
  },
};
