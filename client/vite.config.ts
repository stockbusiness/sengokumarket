import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // @sengoku/contractsはCommonJS(dist/index.js)へビルドされたworkspaceパッケージのため、
  // 開発サーバーの素のESM importでは名前付きexportを解決できない。optimizeDeps.includeで
  // esbuildの事前バンドル対象に含め、CJS→ESM変換を通す(本番ビルドはRollupが変換するため
  // 問題にならず、vite devでのみ顕在化する)。
  optimizeDeps: {
    include: ['@sengoku/contracts'],
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
})
