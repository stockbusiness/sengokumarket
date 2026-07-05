import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 各テストファイルが同一のPostgreSQLに対して実行され、
    // settingsテーブルなどグローバルな行を共有するため直列実行にする。
    fileParallelism: false,
  },
});
