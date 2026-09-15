// 仕様書外の拡張(再発防止): Vercelはmigrationを自動実行しないため、DBスキーマを変更する
// PRをマージしても本番DBへの手動反映を忘れると、Prisma Clientが期待する列が本番DBに
// 存在せず全面的なサーバーエラーになる事故が繰り返し発生していた。
// vercel.jsonのbuildCommandからこのスクリプトを呼び、本番デプロイ(VERCEL_ENV=production)の
// ビルド時にだけ`prisma migrate deploy`を自動実行する。プレビュー(PRごとのデプロイ)は
// 環境変数を本番と共有している可能性があり、マージ前のコードで本番DBへ勝手にmigrationを
// 適用してしまう事故を避けるため、productionのビルドでのみ実行する。
import { execSync } from 'node:child_process';

const vercelEnv = process.env.VERCEL_ENV;

if (vercelEnv !== 'production') {
  console.log(`VERCEL_ENV=${vercelEnv ?? '(未設定)'} のため、prisma migrate deployをスキップします(本番ビルドのみ実行)。`);
  process.exit(0);
}

console.log('VERCEL_ENV=production: prisma migrate deployを実行します。');
execSync('npm run prisma:deploy --workspace=server', { stdio: 'inherit' });
