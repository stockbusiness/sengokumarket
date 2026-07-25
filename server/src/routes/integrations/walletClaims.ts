import { Router } from 'express';
import { sendIntegrationError } from '../../lib/apiError';
import { getRawBodyString } from '../../middleware/walletClaimHmac';
import { confirmWalletClaim, getWalletClaimStatus } from '../../services/walletClaimConfirm';

const router = Router();

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)8章: 千ノ国ウォレットからの
// サーバー間呼び出し専用API。認証(HMAC・timestamp・nonce・rate limit)はapp.tsで
// requireWalletClaimHmacミドルウェアとして先に適用済み。

router.get('/:token', async (req, res) => {
  const result = await getWalletClaimStatus(req.params.token);
  if (!result) return sendIntegrationError(res, 404, 'CLAIM_NOT_FOUND', '指定されたClaimが見つかりません');
  res.json({ ok: true, status: result.status, expires_at: result.expiresAt.toISOString() });
});

router.post('/:token/confirm', async (req, res) => {
  let body: unknown;
  try {
    const raw = getRawBodyString(req);
    body = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return sendIntegrationError(res, 400, 'INVALID_JSON', 'リクエストボディがJSONとして解釈できません');
  }

  const b = body as Record<string, unknown>;
  const oveAccountId = typeof b.ove_account_id === 'string' ? b.ove_account_id.trim() : '';
  const commonUserId = typeof b.common_user_id === 'string' ? b.common_user_id.trim() : '';
  if (!oveAccountId || !commonUserId) {
    return sendIntegrationError(res, 400, 'VALIDATION_ERROR', 'ove_account_id・common_user_idが必要です');
  }

  const outcome = await confirmWalletClaim(req.params.token, { oveAccountId, commonUserId });

  switch (outcome.kind) {
    case 'not_found':
      return sendIntegrationError(res, 404, 'CLAIM_NOT_FOUND', '指定されたClaimが見つかりません');
    case 'expired':
      return sendIntegrationError(res, 410, 'CLAIM_EXPIRED', 'Claimの有効期限が切れています');
    case 'revoked':
      return sendIntegrationError(res, 409, 'CLAIM_REVOKED', 'Claimは返金・取消により無効化されています');
    case 'order_refunded':
      return sendIntegrationError(res, 409, 'ORDER_REFUNDED', '注文は返金済みです');
    case 'order_not_paid':
      return sendIntegrationError(res, 409, 'ORDER_NOT_PAID', '注文の決済が確認できません');
    case 'common_user_mismatch':
      return sendIntegrationError(res, 409, 'COMMON_USER_MISMATCH', 'common_user_idが注文と一致しません');
    case 'conflict':
      return sendIntegrationError(res, 409, 'CLAIM_PROCESSING', '他のリクエストが処理中です。しばらくしてから再度お試しください');
    case 'common_user_unresolved':
      // 9章「未解決」: エラーではなく保留(送付待ち)として扱う。
      return res.status(202).json({ ok: true, action: 'common_user_unresolved' });
    case 'ok':
      return res.status(200).json({ ok: true, status: outcome.status });
  }
});

export default router;
