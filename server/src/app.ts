import express, { Express, NextFunction, Request, Response } from 'express';
// Express 4はasyncハンドラ内の例外(Promise reject)を自動でエラーミドルウェアに回さず、
// 何も応答しないままリクエストが無限にハングする(例: マイグレーション未適用によるDBエラー時)。
// これを防ぐため、ルート定義より前に読み込む(パッチ適用はimportの副作用による)。
import 'express-async-errors';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import productsRouter from './routes/products';
import legalRouter from './routes/legal';
import cartRouter from './routes/cart';
import checkoutRouter from './routes/checkout';
import referralsRouter from './routes/referrals';
import authRouter from './routes/auth';
import mypageRouter from './routes/mypage';
import adminRouter from './routes/admin';
import agencyRouter from './routes/agency';
import integrationAgenciesRouter from './routes/integrations/agencies';
import internalCronRouter from './routes/internalCron';
import { stripeWebhookHandler } from './routes/stripeWebhook';
import { requireSameOrigin } from './middleware/csrf';
import { requireAgencyApiKey } from './middleware/integrationAuth';
import { requireCronSecret } from './middleware/cronAuth';
import { sendError } from './lib/apiError';

export function createApp(): Express {
  const app = express();

  // セキュリティヘッダー(X-Content-Type-Options/X-Frame-Options等)。
  // このAppはJSON APIのみを返すためcontentSecurityPolicy/hstsは無効化し、静的サイト側はvercel.jsonで別途設定する。
  app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  app.use(cors({ origin: process.env.APP_URL, credentials: true }));

  // Stripe Webhookは署名検証に生ボディが必要なため、express.json()より前に
  // express.raw()付きで登録する(仕様書v1.5 7.3参照。事故多発地帯につき順序厳守)。
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

  app.use(express.json());
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // 外部の代理店システムからのサーバー間API連携。Cookie/Originに依存しないAPIキー認証のため、
  // ブラウザCookieセッション向けのOrigin検証(requireSameOrigin)より前に登録する(仕様書外の拡張)。
  app.use('/api/integrations/agencies', requireAgencyApiKey, integrationAgenciesRouter);

  // Vercel Cronからの呼び出し。Cookie/Originに依存しないため同様にrequireSameOriginより前段に置く(仕様書外の拡張)。
  app.use('/api/internal/cron', requireCronSecret, internalCronRouter);

  // Cookie認証はSameSite=Strict + Origin検証でCSRF対策する(仕様書v1.5 16章)。
  app.use('/api', requireSameOrigin);

  app.use('/api', productsRouter);
  app.use('/api', legalRouter);
  app.use('/api', cartRouter);
  app.use('/api', checkoutRouter);
  app.use('/api', referralsRouter);
  app.use('/api', authRouter);
  app.use('/api/mypage', mypageRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/agency', agencyRouter);

  // 未捕捉の例外もAPIエラーレスポンス形式に統一する(仕様書v1.5コーディング規約)。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    sendError(res, 500, 'SERVER_ERROR', 'サーバーエラーが発生しました');
  });

  return app;
}
