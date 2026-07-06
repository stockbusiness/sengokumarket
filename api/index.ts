// Vercel Serverless Functions用のエントリポイント。
// /api/:path* のリクエストはすべてこの関数に集約され、Expressアプリ内部の
// ルーティング(app.ts)でパスごとに処理される。ローカル開発では使用しない
// (ローカルは server/src/index.ts が app.listen() で起動する)。
import { createApp } from '../server/src/app';

export default createApp();
