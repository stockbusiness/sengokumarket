import { defineConfig } from 'vitest/config';

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
