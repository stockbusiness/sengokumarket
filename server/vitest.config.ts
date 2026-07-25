import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

// 本番安定化指示書Stage12: src/index.ts(実サーバー起動)は.envをdotenv.config()で読み込むが、
// vitest実行時は読み込まれていなかった。そのため、appConfig.appUrl等がprocess.env.APP_URL
// (本番・CIでは必須環境変数として必ず設定される)を参照するテンプレートのスナップショットが、
// ローカルでは「APP_URL未設定」相当の値でパスしてしまい、CI(APP_URLを明示的に設定)でだけ
// 失敗するという不整合(walletReminder等のテンプレート5ファイル・8テストで実際に発生した)を
// 生んでいた。ここで読み込むことで、ローカルとCIの前提を揃える。
dotenv.config();

export default defineConfig({
  test: {
    // 各テストファイルが同一のPostgreSQLに対して実行され、
    // settingsテーブルなどグローバルな行を共有するため直列実行にする。
    fileParallelism: false,
    // 残課題指示書Stage2: npm run build(tsc出力)後にdist/配下へコンパイル済みの.test.jsが
    // 生成され、既定のglobだとそれもテスト対象として拾ってしまいCommonJS実行時エラーになる。
    // ビルド成果物はテスト対象から明示的に除外する。
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
