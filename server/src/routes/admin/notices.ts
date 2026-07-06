import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';

const router = Router();

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

router.get('/notices', async (_req, res) => {
  const notices = await prisma.notice.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ notices });
});

router.post('/notices', async (req, res) => {
  const { title, body } = req.body ?? {};
  if (!isNonEmptyString(title)) return sendError(res, 400, 'VALIDATION_ERROR', 'タイトルを入力してください');
  if (!isNonEmptyString(body)) return sendError(res, 400, 'VALIDATION_ERROR', '本文を入力してください');

  const notice = await prisma.notice.create({ data: { title, body, status: 'draft' } });
  res.status(201).json({ notice });
});

router.put('/notices/:id', async (req, res) => {
  const { title, body, status } = req.body ?? {};
  const existing = await prisma.notice.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 404, 'NOTICE_NOT_FOUND', 'お知らせが見つかりません');

  if (status !== undefined && !['draft', 'published'].includes(status)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ステータスが不正です');
  }

  // 公開時にpublished_atを記録する(仕様書v1.5 5.7)。一度記録した公開日時は再公開時も変えない。
  const shouldSetPublishedAt = status === 'published' && !existing.publishedAt;

  const notice = await prisma.notice.update({
    where: { id: req.params.id },
    data: {
      title: isNonEmptyString(title) ? title : undefined,
      body: isNonEmptyString(body) ? body : undefined,
      status: status ?? undefined,
      publishedAt: shouldSetPublishedAt ? new Date() : undefined,
    },
  });

  res.json({ notice });
});

router.delete('/notices/:id', async (req, res) => {
  const existing = await prisma.notice.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 404, 'NOTICE_NOT_FOUND', 'お知らせが見つかりません');

  await prisma.notice.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

export default router;
