import express, { Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import productsRouter from './routes/products';
import cartRouter from './routes/cart';

export function createApp(): Express {
  const app = express();

  app.use(cors({ origin: process.env.APP_URL, credentials: true }));

  // Stripe Webhookルートはここ(express.json()より前)に express.raw() 付きで追加する。
  // 署名検証には生ボディが必要なため(Step 6で実装。仕様書v1.5 7.3参照)。

  app.use(express.json());
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api', productsRouter);
  app.use('/api', cartRouter);

  return app;
}
