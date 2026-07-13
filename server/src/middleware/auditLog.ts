import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

// リクエストボディに含まれうる秘密情報は監査ログへ平文で残さない(CLAUDE.md「秘密情報をコードにハードコードしない」と同趣旨)。
const REDACTED_KEYS = new Set([
  'password',
  'newPassword',
  'stripe_secret_key',
  'stripe_webhook_secret',
  'stripe_public_key',
  'resend_api_key',
  'agency_api_key',
  'external_agency_system_api_key',
  'nft_mint_api_key',
  'token',
]);

function redactBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key) && value ? '[REDACTED]' : value;
  }
  return out;
}

async function writeAuditLog(req: Request, res: Response): Promise<void> {
  const actor = req.authUser;
  if (!actor) return;

  const user = await prisma.user.findUnique({ where: { id: actor.id }, select: { email: true } });
  await prisma.adminAuditLog.create({
    data: {
      actorUserId: actor.id,
      actorEmail: user?.email ?? 'unknown',
      actorRole: actor.role,
      method: req.method,
      path: req.originalUrl,
      requestBody: redactBody(req.body) as never,
      statusCode: res.statusCode,
    },
  });
}

// GET以外(状態変更操作)のみ、誰が・いつ・どのAPIに・何を送って操作したかを記録する。
// requireAdmin/requireAgencyの後段に配線し、req.authUserが確定した状態で使うこと(仕様書外の拡張)。
//
// サーバーレス環境(Vercel)ではレスポンス送出後すぐにプロセスが凍結されうるため、
// res.on('finish')的な後追いのfire-and-forgetでは書き込みが完了しない恐れがある。
// そのためres.json/res.sendを差し替え、実際にレスポンスを送出する前に書き込みを完了させる。
export function auditLog(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET') return next();

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  let logged = false;

  async function logOnce() {
    if (logged) return;
    logged = true;
    try {
      await writeAuditLog(req, res);
    } catch (e) {
      console.error('監査ログの記録に失敗しました', e);
    }
  }

  res.json = ((body?: unknown) => {
    void logOnce().finally(() => originalJson(body));
    return res;
  }) as typeof res.json;

  res.send = ((body?: unknown) => {
    void logOnce().finally(() => originalSend(body));
    return res;
  }) as typeof res.send;

  next();
}
