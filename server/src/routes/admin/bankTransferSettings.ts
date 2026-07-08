import { Router } from 'express';
import { sendError } from '../../lib/apiError';
import { getBankTransferConfig, setBankTransferConfig } from '../../services/bankTransfer';

const router = Router();

// 仕様書外の拡張: 銀行振込(手動確認型)の有効/無効・案内文設定。
// 秘密情報ではないため、他の設定(/admin/settings)と異なりマスクせず平文で取得・保存する。
router.get('/bank-transfer-settings', async (_req, res) => {
  const config = await getBankTransferConfig();
  res.json(config);
});

router.put('/bank-transfer-settings', async (req, res) => {
  const { enabled, info } = req.body ?? {};

  if (typeof enabled !== 'boolean') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'enabledはtrue/falseで指定してください');
  }
  if (typeof info !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'infoを文字列で指定してください');
  }

  await setBankTransferConfig({ enabled, info });
  const config = await getBankTransferConfig();
  res.json(config);
});

export default router;
