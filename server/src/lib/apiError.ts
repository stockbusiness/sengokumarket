import { Response } from 'express';

export function sendError(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

// 外部代理店システム(sengoku-ai.com)との連携APIは、こちら独自の{error:{code,message}}形式ではなく
// 先方の外部開発者向け連携ガイド(v3.6.78-draft)13章が指定する{ok:false, error:{code,message}}形式で
// エラーを返す必要がある(仕様書外の拡張)。この関数は/api/integrations配下の連携エンドポイント専用とし、
// アプリ内部向けのsendErrorとは使い分ける。
export function sendIntegrationError(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ ok: false, error: { code, message } });
}
