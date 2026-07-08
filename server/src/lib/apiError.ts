import { Response } from 'express';

export function sendError(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

// 外部代理店システム(sengoku-ai.com)との連携APIは、こちら独自の{error:{code,message}}形式ではなく
// 先方仕様書(v3.6.40)が指定する{success:false, message}形式でエラーを返す必要がある(仕様書外の拡張)。
// この関数は/api/integrations配下の連携エンドポイント専用とし、アプリ内部向けのsendErrorとは使い分ける。
export function sendIntegrationError(res: Response, status: number, message: string) {
  res.status(status).json({ success: false, message });
}
