import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';

const router = Router();

const LEGAL_SLUGS = ['tokushoho', 'terms', 'refund', 'privacy'] as const;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

router.get('/legal', async (_req, res) => {
  const documents = await prisma.legalDocument.findMany({ orderBy: { slug: 'asc' } });
  res.json({ documents });
});

router.put('/legal/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!LEGAL_SLUGS.includes(slug as (typeof LEGAL_SLUGS)[number])) {
    return sendError(res, 404, 'LEGAL_DOCUMENT_NOT_FOUND', 'ページが見つかりません');
  }

  const { title, body } = req.body ?? {};
  if (!isNonEmptyString(title)) return sendError(res, 400, 'VALIDATION_ERROR', 'タイトルを入力してください');
  if (!isNonEmptyString(body)) return sendError(res, 400, 'VALIDATION_ERROR', '本文を入力してください');

  const document = await prisma.legalDocument.upsert({
    where: { slug },
    update: { title, body },
    create: { slug, title, body },
  });

  res.json({ document });
});

export default router;
