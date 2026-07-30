import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/apiError';
import { HttpError } from '../lib/httpError';
import { dbRateLimit } from '../middleware/dbRateLimit';
import { createWalletVerificationChallenge, verifyAndRegisterWallet } from '../services/walletVerification';
import { validateWalletRegistrationLink, consumeWalletRegistrationLink } from '../services/walletRegistrationLink';

const router = Router();
const WALLET_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// 仕様書外の拡張: 既に決済済みだがウォレット未登録の購入者向け、管理者発行の登録用URL専用の
// 公開エンドポイント群(/auth/password-reset/confirmと同じくログイン不要)。
const walletRegistrationLimiter = dbRateLimit({ windowMs: 15 * 60 * 1000, limit: 30, scope: 'wallet-registration' });

router.get('/wallet-registration/status', walletRegistrationLimiter, async (req, res) => {
  const token = req.query.token;
  if (typeof token !== 'string' || token.length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'トークンを指定してください');
  }
  const { status } = await validateWalletRegistrationLink(token);
  res.json({ status });
});

router.post('/wallet-registration/nonce', walletRegistrationLimiter, async (req, res) => {
  const { token, walletAddress } = req.body ?? {};
  if (typeof token !== 'string' || token.length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'トークンを指定してください');
  }
  if (typeof walletAddress !== 'string' || !WALLET_ADDRESS_RE.test(walletAddress)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ウォレットアドレスの形式が正しくありません');
  }

  const { status, userId } = await validateWalletRegistrationLink(token);
  if (status !== 'active' || !userId) {
    return sendError(res, 400, 'INVALID_OR_EXPIRED_TOKEN', 'この登録用リンクは無効または期限切れです');
  }

  const challenge = await prisma.$transaction((tx) => createWalletVerificationChallenge(tx, userId, walletAddress));
  res.json(challenge);
});

router.post('/wallet-registration/confirm', walletRegistrationLimiter, async (req, res) => {
  const { token, walletAddress, signature } = req.body ?? {};
  if (typeof token !== 'string' || token.length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'トークンを指定してください');
  }
  if (typeof walletAddress !== 'string' || !WALLET_ADDRESS_RE.test(walletAddress)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ウォレットアドレスの形式が正しくありません');
  }
  if (typeof signature !== 'string' || signature.trim().length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', '署名が見つかりません');
  }

  const { status, userId } = await validateWalletRegistrationLink(token);
  if (status !== 'active' || !userId) {
    return sendError(res, 400, 'INVALID_OR_EXPIRED_TOKEN', 'この登録用リンクは無効または期限切れです');
  }

  try {
    const wallet = await prisma.$transaction((tx) => verifyAndRegisterWallet(tx, { userId, walletAddress, signature }));
    await consumeWalletRegistrationLink(token);
    res.json({
      wallet: { walletAddress: wallet.walletAddress, chain: wallet.chain, verified: wallet.verified, verifiedAt: wallet.verifiedAt },
    });
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

export default router;
