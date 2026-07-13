import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { sendWalletReminderEmail } from '../../services/mailTemplates';

const router = Router();

router.get('/wallet-missing', async (_req, res) => {
  const nftIssues = await prisma.nftIssue.findMany({
    where: { status: 'wallet_required' },
    include: { order: true, product: true, walletReminderEmails: { orderBy: { sentAt: 'desc' }, take: 1 } },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    walletMissing: nftIssues.map((issue) => ({
      id: issue.id,
      customerName: issue.order.customerName,
      customerEmail: issue.order.customerEmail,
      orderNumber: issue.order.orderNumber,
      productName: issue.product.name,
      purchasedAt: issue.order.paidAt ?? issue.order.createdAt,
      lastReminderSentAt: issue.walletReminderEmails[0]?.sentAt ?? null,
    })),
  });
});

// 仕様書外の拡張(仕様書5.5「最終案内メール送信日時」相当): 未登録者へ登録案内メールを
// (再)送信する。ウォレットアドレス自体の登録・変更は署名検証必須のまま、本人がマイページから
// 行う(仕様書外の拡張・実装済み)。ここでは送信記録を残すのみで、ウォレットの状態は変更しない。
router.post('/wallet-missing/:nftIssueId/reminder', async (req, res) => {
  const nftIssue = await prisma.nftIssue.findUnique({ where: { id: req.params.nftIssueId }, include: { order: true } });
  if (!nftIssue || nftIssue.status !== 'wallet_required') {
    return sendError(res, 404, 'NFT_ISSUE_NOT_FOUND', 'ウォレット未登録の対象が見つかりません');
  }
  if (!nftIssue.userId) {
    return sendError(res, 400, 'VALIDATION_ERROR', '会員アカウントに紐づいていないため案内メールを送信できません');
  }

  await sendWalletReminderEmail(nftIssue.order.customerEmail, nftIssue.order.customerName, nftIssue.order.orderNumber);
  const log = await prisma.walletReminderEmail.create({
    data: { nftIssueId: nftIssue.id, sentBy: req.authUser!.id },
  });

  res.status(201).json({ lastReminderSentAt: log.sentAt });
});

// 案内メールの送信記録を削除する(誤送信の記録整理用。メール自体の取り消しはできない)。
router.delete('/wallet-missing/:nftIssueId/reminder', async (req, res) => {
  const nftIssue = await prisma.nftIssue.findUnique({ where: { id: req.params.nftIssueId } });
  if (!nftIssue) {
    return sendError(res, 404, 'NFT_ISSUE_NOT_FOUND', 'ウォレット未登録の対象が見つかりません');
  }

  await prisma.walletReminderEmail.deleteMany({ where: { nftIssueId: nftIssue.id } });

  res.status(204).end();
});

export default router;
