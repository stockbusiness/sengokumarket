import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';

const router = Router();

const STATUSES = ['wallet_required', 'ready_to_issue', 'issued', 'failed', 'cancelled'];
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

router.get('/nft-issues', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;

  const nftIssues = await prisma.nftIssue.findMany({
    where: status ? { status } : undefined,
    include: { order: true, product: true, variant: true },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    nftIssues: nftIssues.map((issue) => ({
      id: issue.id,
      orderNumber: issue.order.orderNumber,
      customerName: issue.order.customerName,
      productName: issue.product.name,
      variantName: issue.variant?.name ?? null,
      walletAddress: issue.walletAddress,
      status: issue.status,
      tokenId: issue.tokenId,
      transactionHash: issue.transactionHash,
      issuedAt: issue.issuedAt,
      adminNote: issue.adminNote,
    })),
  });
});

// issuedへの変更はtoken_id / transaction_hashを必須とし、issued_atを自動記録する(仕様書v1.5 5.4 / 8章)。
router.put('/nft-issues/:id', async (req, res) => {
  const { status, tokenId, transactionHash, adminNote } = req.body ?? {};

  const existing = await prisma.nftIssue.findUnique({ where: { id: req.params.id } });
  if (!existing) return sendError(res, 404, 'NFT_ISSUE_NOT_FOUND', 'NFT発行データが見つかりません');

  if (status !== undefined && !STATUSES.includes(status)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ステータスが不正です');
  }

  if (status === 'issued') {
    const finalTokenId = tokenId ?? existing.tokenId;
    const finalTxHash = transactionHash ?? existing.transactionHash;
    if (!finalTokenId) return sendError(res, 400, 'VALIDATION_ERROR', 'token IDを入力してください');
    if (!finalTxHash || !TX_HASH_RE.test(finalTxHash)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'transaction hashの形式が正しくありません');
    }
  }

  const updated = await prisma.nftIssue.update({
    where: { id: req.params.id },
    data: {
      status: status ?? undefined,
      tokenId: tokenId !== undefined ? tokenId : undefined,
      transactionHash: transactionHash !== undefined ? transactionHash : undefined,
      adminNote: typeof adminNote === 'string' ? adminNote : undefined,
      issuedAt: status === 'issued' && !existing.issuedAt ? new Date() : undefined,
    },
  });

  res.json({ nftIssue: updated });
});

export default router;
