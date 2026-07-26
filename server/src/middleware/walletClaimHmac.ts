import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { sendIntegrationError } from '../lib/apiError';
import { buildSennokuniSigningString, signSennokuniRequest } from '../lib/sennokuniHmac';
import { getWalletClaimInboundCredentials, isWalletClaimEnabled } from '../services/walletClaimConfig';

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)8章: 千ノ国ウォレットから
// サーバー間で呼ばれるClaim確認API(/api/integrations/wallet-claims/...)専用のHMAC認証。
// 署名対象の組み立ては既存のsennokuniHmac.ts(共通契約 X-SenNoKuni-*方式)をそのまま流用するが、
// 検証に使う鍵(wallet_claim_inbound_*)は代理店HUB向け(sennokuni_hmac_*)・OVE reward向け
// (ove_wallet_*)のいずれとも別の専用system keyとする(用途混同による誤送信・不正な権限昇格を防ぐ)。
//
// Wallet Claim本番前安定化指示書(2026-07-25)Phase2: 処理順序は
// Feature Flag確認→ヘッダー必須確認→ヘッダー最大長確認→credential取得→key ID比較→
// timestamp検証→raw body取得→HMAC署名検証→nonce INSERT→next() の順に固定する。
// 署名検証より前にnonceをINSERTしない(無効な署名のリクエストでnonce行が増え続けるのを防ぐ)。

// タイムスタンプの許容誤差。この範囲外は古い/未来のリクエストとしてリプレイとみなす。
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

// Phase2(4.4「最大長」): 想定外に長いヘッダー・bodyでの資源浪費・DoS的な負荷を防ぐ。
const MAX_LENGTHS = {
  keyId: 128,
  timestamp: 32,
  nonce: 128,
  signature: 256,
  idempotencyKey: 256,
  claimToken: 256,
  rawBody: 64 * 1024,
} as const;

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function getRawBodyString(req: Request): string {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  return '';
}

export async function requireWalletClaimHmac(req: Request, res: Response, next: NextFunction) {
  // 18章: ENABLE_WALLET_CLAIM=false(既定)の間はこの機能全体がdormant。認証情報の有無に関わらず
  // 常に503を返す(HMAC検証を先に行わせない。無効化中は動作を一切変えないという既存方針を踏襲)。
  if (!isWalletClaimEnabled()) {
    return sendIntegrationError(res, 503, 'WALLET_CLAIM_DISABLED', 'Claim機能は現在無効化されています');
  }

  const keyId = req.header('x-sennokuni-key-id');
  const timestamp = req.header('x-sennokuni-timestamp');
  const nonce = req.header('x-sennokuni-nonce');
  const signature = req.header('x-sennokuni-signature');
  const idempotencyKey = req.header('idempotency-key');

  if (!keyId || !timestamp || !nonce || !signature || !idempotencyKey) {
    return sendIntegrationError(res, 401, 'AUTH_HEADERS_REQUIRED', 'HMAC認証に必要なヘッダーが不足しています');
  }

  const claimTokenSegment = req.path.split('/').filter(Boolean)[0] ?? '';
  if (
    keyId.length > MAX_LENGTHS.keyId ||
    timestamp.length > MAX_LENGTHS.timestamp ||
    nonce.length > MAX_LENGTHS.nonce ||
    signature.length > MAX_LENGTHS.signature ||
    idempotencyKey.length > MAX_LENGTHS.idempotencyKey ||
    claimTokenSegment.length > MAX_LENGTHS.claimToken
  ) {
    return sendIntegrationError(res, 400, 'HEADER_TOO_LONG', 'ヘッダーまたはパスの長さが上限を超えています');
  }
  const rawBody = getRawBodyString(req);
  if (rawBody.length > MAX_LENGTHS.rawBody) {
    return sendIntegrationError(res, 400, 'BODY_TOO_LARGE', 'リクエストボディが大きすぎます');
  }

  const credentials = await getWalletClaimInboundCredentials();
  if (!credentials) {
    return sendIntegrationError(res, 503, 'WALLET_CLAIM_CREDENTIALS_NOT_CONFIGURED', 'Claim確認APIの認証情報が設定されていません');
  }

  if (!timingSafeEqualStrings(keyId, credentials.keyId)) {
    return sendIntegrationError(res, 401, 'INVALID_KEY_ID', 'system keyが正しくありません');
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return sendIntegrationError(res, 401, 'INVALID_TIMESTAMP', 'timestampの形式が正しくありません');
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > TIMESTAMP_TOLERANCE_SECONDS) {
    return sendIntegrationError(res, 401, 'TIMESTAMP_OUT_OF_RANGE', 'timestampが許容範囲外です');
  }

  const path = req.originalUrl.split('?')[0];
  const expectedSignature = signSennokuniRequest({
    keyId,
    timestamp,
    nonce,
    method: req.method,
    path,
    rawBody,
    idempotencyKey,
    secret: credentials.secret,
  });

  if (!timingSafeEqualStrings(signature, expectedSignature)) {
    return sendIntegrationError(res, 401, 'INVALID_SIGNATURE', '署名が正しくありません');
  }

  // 署名検証を通過したリクエストのみnonceを記録する(Phase2: 無効署名でnonce行を作らない)。
  // UNIQUE制約違反(P2002)のみをリプレイとして扱い、それ以外のDBエラーは呼び出し元へ
  // 伝播させる(DB障害をnonce再利用と誤判定しない)。
  try {
    await prisma.walletClaimApiNonce.create({ data: { nonce } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return sendIntegrationError(res, 401, 'NONCE_REUSED', 'nonceは既に使用されています');
    }
    throw e;
  }

  next();
}

// テスト・呼び出し元での署名生成に使う(buildSennokuniSigningStringの再エクスポート)。
export { buildSennokuniSigningString };

// Wallet Claim本番前安定化指示書(2026-07-25)Phase2(4.5「nonce cleanup」): timestamp許容誤差
// (5分)を大きく超えた古いnonceは、リプレイ判定に二度と使われないため安全に削除できる。
// 24時間分残すのは、cron取りこぼし・時計ずれ等に対する余裕を持たせるため。
const NONCE_RETENTION_MS = 24 * 60 * 60 * 1000;

export async function cleanupWalletClaimApiNonces(): Promise<{ deletedCount: number }> {
  const result = await prisma.walletClaimApiNonce.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - NONCE_RETENTION_MS) } },
  });
  return { deletedCount: result.count };
}
