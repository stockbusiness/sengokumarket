import { Router } from 'express';
import { sendError } from '../../lib/apiError';
import { importProductsFromCsv } from '../../services/csvImport';

const router = Router();

router.post('/import-products', async (req, res) => {
  const { csvContent, dryRun } = req.body ?? {};

  if (typeof csvContent !== 'string' || csvContent.trim().length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'CSVの内容を指定してください');
  }

  try {
    const result = await importProductsFromCsv(csvContent, dryRun !== false);
    res.json(result);
  } catch (e) {
    sendError(res, 400, 'CSV_PARSE_ERROR', e instanceof Error ? e.message : 'CSVの解析に失敗しました');
  }
});

export default router;
