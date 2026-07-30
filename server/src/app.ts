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
import walletRegistrationRouter from './routes/walletRegistration';
import mypageRouter from './routes/mypage';
import adminRouter from './routes/admin';
import agencyRouter from './routes/agency';
import integrationAgenciesRouter from './modules/agencies/http/agencyIntegration.routes';
import walletClaimsRouter from './routes/integrations/walletClaims';
import internalCronRouter from './routes/internalCron';
import readyRouter from './routes/ready';
import { stripeWebhookHandler } from './routes/stripeWebhook';
import { requireSameOrigin } from './middleware/csrf';
import { requireAgencyApiKey } from './middleware/integrationAuth';
import { requireWalletClaimHmac } from './middleware/walletClaimHmac';
import { requireCronSecret } from './middleware/cronAuth';
import { dbRateLimit } from './middleware/dbRateLimit';
import { hashRateLimitIdentifier } from './services/rateLimiter';
import { sendError } from './lib/apiError';
import { appConfig } from './shared/config/appConfig';

export function createApp(): Express {
  const app = express();

  // 本番安定化指示書Stage3(6.5「IP取得」): VercelはNode.jsの手前に1段プロキシ層を挟むため、
  // req.ipがそのプロキシのIPになってしまい、レート制限のIP判定が機能しない。
  // trust proxyを1(1ホップだけ信頼)に設定することで、X-Forwarded-Forの末尾から1つ手前
  // (実クライアントのIP)をreq.ipとして採用する。trueや無制限のホップ数を信頼すると、
  // クライアントが任意個のダミーIPをX-Forwarded-Forへ自分で追加してreq.ipを偽装できて
  // しまうため、明示的に1ホップのみを信頼する(実際のVercel環境でのホップ数は本番で
  // 別途確認が必要)。
  app.set('trust proxy', 1);

  // セキュリティヘッダー(X-Content-Type-Options/X-Frame-Options等)。
  // このAppはJSON APIのみを返すためcontentSecurityPolicy/hstsは無効化し、静的サイト側はvercel.jsonで別途設定する。
  app.use(helmet({ contentSecurityPolicy: false, hsts: false }));
  app.use(cors({ origin: appConfig.appUrl, credentials: true }));

  // Stripe Webhookは署名検証に生ボディが必要なため、express.json()より前に
  // express.raw()付きで登録する(仕様書v1.5 7.3参照。事故多発地帯につき順序厳守)。
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

  // 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)8章: Claim確認APIも
  // HMAC署名検証に生ボディが必要なため、Stripe Webhookと同様express.json()より前に
  // express.raw()付きで登録する。IP制限をHMAC検証より前段に置く方針は/api/integrations/agencies
  // と同じ(6.6「外部API」)。
  const walletClaimIpLimiter = dbRateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    scope: 'wallet-claim-integration-ip',
    errorFormat: 'integration',
  });
  const walletClaimKeyLimiter = dbRateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    scope: 'wallet-claim-integration-key',
    errorFormat: 'integration',
    includeCombinedBucket: false,
    includeIpBucket: false,
    identify: (req) => {
      const keyId = req.header('x-sennokuni-key-id');
      return keyId ? hashRateLimitIdentifier(keyId) : undefined;
    },
  });
  app.use(
    '/api/integrations/wallet-claims',
    express.raw({ type: 'application/json' }),
    walletClaimIpLimiter,
    requireWalletClaimHmac,
    walletClaimKeyLimiter,
    walletClaimsRouter,
  );

  app.use(express.json());
  app.use(cookieParser());

  // プロセス生存確認のみ(DBには一切触れない)。DB・migration状態は/api/readyで確認する
  // (本番安定化指示書Stage0: Vercelデプロイ成功と本番DB migration成功を混同しないため)。
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/api', readyRouter);

  // 外部の代理店システムからのサーバー間API連携。Cookie/Originに依存しないAPIキー認証のため、
  // ブラウザCookieセッション向けのOrigin検証(requireSameOrigin)より前に登録する(仕様書外の拡張)。
  // 本番安定化指示書Stage3(6.6「外部API」): IP制限をAPIキー認証より前段に置くことで、
  // 誤ったAPIキーを大量に試すこと自体をAPIキー検証(DB参照を伴う)へ到達させる前に弾く。
  // APIキー認証後は、APIキー自体を識別子とした2段目の制限も掛ける(APIキーは呼び出し元全体で
  // 共有される1本のため、IP単独の制限だけでは正規の呼び出し元が複数IPを使う場合に弱い)。
  const agencyIntegrationIpLimiter = dbRateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    scope: 'agency-integration-ip',
    errorFormat: 'integration',
  });
  const agencyIntegrationKeyLimiter = dbRateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    scope: 'agency-integration-key',
    errorFormat: 'integration',
    includeCombinedBucket: false,
    includeIpBucket: false,
    identify: (req) => {
      const bearerMatch = req.header('authorization')?.match(/^Bearer (.+)$/);
      const provided = req.header('x-api-key') ?? bearerMatch?.[1];
      return typeof provided === 'string' && provided.length > 0 ? hashRateLimitIdentifier(provided) : undefined;
    },
  });
  app.use(
    '/api/integrations/agencies',
    agencyIntegrationIpLimiter,
    requireAgencyApiKey,
    agencyIntegrationKeyLimiter,
    integrationAgenciesRouter,
  );

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
  app.use('/api', walletRegistrationRouter);
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
