import express, { Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import productsRouter from './routes/products';
import cartRouter from './routes/cart';
import checkoutRouter from './routes/checkout';
import referralsRouter from './routes/referrals';
import authRouter from './routes/auth';
import mypageRouter from './routes/mypage';
import { stripeWebhookHandler } from './routes/stripeWebhook';
import { requireSameOrigin } from './middleware/csrf';

export function createApp(): Express {
  const app = express();

  app.use(cors({ origin: process.env.APP_URL, credentials: true }));

  // Stripe Webhookは署名検証に生ボディが必要なため、express.json()より前に
  // express.raw()付きで登録する(仕様書v1.5 7.3参照。事故多発地帯につき順序厳守)。
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

  app.use(express.json());
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Cookie認証はSameSite=Strict + Origin検証でCSRF対策する(仕様書v1.5 16章)。
  app.use('/api', requireSameOrigin);

  app.use('/api', productsRouter);
  app.use('/api', cartRouter);
  app.use('/api', checkoutRouter);
  app.use('/api', referralsRouter);
  app.use('/api', authRouter);
  app.use('/api', mypageRouter);

  return app;
}
