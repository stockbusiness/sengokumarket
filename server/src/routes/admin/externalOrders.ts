import { Router } from 'express';
import { sendError } from '../../lib/apiError';
import { HttpError } from '../../lib/httpError';
import { createExternalOrder, importExternalOrdersFromCsv } from '../../services/externalOrderImport';

const router = Router();

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function parsePurchasedAt(v: unknown): { ok: true; value: Date | null } | { ok: false } {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false };
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return { ok: false };
  return { ok: true, value: d };
}

// 仕様書外の拡張: このシステム以外の販路(戦国パスポート等)で既に決済が完了している購入者を
// 手動で1件登録する。ウォレット登録は既存の署名検証必須のフロー(mypage/wallet)に委ねる。
router.post('/external-orders', async (req, res) => {
  const { customerName, customerEmail, customerPhone, sku, quantity, purchasedAt, externalReference, adminNote } = req.body ?? {};

  if (!isNonEmptyString(customerName)) return sendError(res, 400, 'VALIDATION_ERROR', '購入者名を入力してください');
  if (!isNonEmptyString(customerEmail)) return sendError(res, 400, 'VALIDATION_ERROR', 'メールアドレスを入力してください');
  if (!isNonEmptyString(sku)) return sendError(res, 400, 'VALIDATION_ERROR', 'SKUを入力してください');
  if (!Number.isInteger(quantity) || quantity < 1) return sendError(res, 400, 'VALIDATION_ERROR', '数量は1以上の整数で入力してください');

  const purchasedAtResult = parsePurchasedAt(purchasedAt);
  if (!purchasedAtResult.ok) return sendError(res, 400, 'VALIDATION_ERROR', '購入日の形式が正しくありません');

  try {
    const order = await createExternalOrder({
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim(),
      customerPhone: isNonEmptyString(customerPhone) ? customerPhone.trim() : null,
      sku: sku.trim(),
      quantity,
      purchasedAt: purchasedAtResult.value,
      externalReference: isNonEmptyString(externalReference) ? externalReference.trim() : null,
      adminNote: isNonEmptyString(adminNote) ? adminNote.trim() : null,
    });
    res.status(201).json({ order: { id: order.id, orderNumber: order.orderNumber } });
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
});

// CSV一括取り込み。dryRun=trueはSKU存在・在庫チェックのみ行い、実際の登録は行わない(仕様書5.6のプレビュー相当)。
router.post('/external-orders/import-csv', async (req, res) => {
  const { csvContent, dryRun } = req.body ?? {};

  if (typeof csvContent !== 'string' || csvContent.trim().length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'CSVの内容を指定してください');
  }

  try {
    const result = await importExternalOrdersFromCsv(csvContent, dryRun !== false);
    res.json(result);
  } catch (e) {
    sendError(res, 400, 'CSV_PARSE_ERROR', e instanceof Error ? e.message : 'CSVの解析に失敗しました');
  }
});

export default router;
