import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { sendIntegrationError } from '../lib/apiError';
import { buildSennokuniSigningString, signSennokuniRequest } from '../lib/sennokuniHmac';
import { getWalletClaimInboundCredentials, isWalletClaimEnabled } from '../services/walletClaimConfig';

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)8章: 千ノ国ウォレットから
// サーバー間で呼ばれるClaim確認API(/api/integrations/wallet-claims/...)専用のHMAC認証。
// 署名対象の組み立ては既存のsennokuniHmac.ts(共通契約 X-SenNoKuni-*方式)をそのまま流用するが、
// 検証に使う鍵(wallet_claim_inbound_*)は代理店HUB向け(sennokuni_hmac_*)・OVE reward向け
// (ove_wallet_*)のいずれとも別の専用system keyとする(用途混同による誤送信・不正な権限昇格を防ぐ)。

// タイムスタンプの許容誤差。この範囲外は古い/未来のリクエストとしてリプレイとみなす。
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

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

  // nonceのリプレイ防止。UNIQUE制約への違反(=既に使用済み)を「拒否」として扱う。
  try {
    await prisma.walletClaimApiNonce.create({ data: { nonce } });
  } catch {
    return sendIntegrationError(res, 401, 'NONCE_REUSED', 'nonceは既に使用されています');
  }

  const rawBody = getRawBodyString(req);
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

  next();
}

// テスト・呼び出し元での署名生成に使う(buildSennokuniSigningStringの再エクスポート)。
export { buildSennokuniSigningString };
