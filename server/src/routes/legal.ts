import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/apiError';

const router = Router();

const LEGAL_SLUGS = ['tokushoho', 'terms', 'refund', 'privacy'] as const;

router.get('/legal/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!LEGAL_SLUGS.includes(slug as (typeof LEGAL_SLUGS)[number])) {
    return sendError(res, 404, 'LEGAL_DOCUMENT_NOT_FOUND', 'ページが見つかりません');
  }

  const document = await prisma.legalDocument.findUnique({ where: { slug } });
  if (!document) {
    return sendError(res, 404, 'LEGAL_DOCUMENT_NOT_FOUND', 'ページが見つかりません');
  }

  res.json({ document: { slug: document.slug, title: document.title, body: document.body } });
});

export default router;
