import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/apiError';
import { requireAuth } from '../middleware/auth';

const router = Router();

const WALLET_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

router.use(requireAuth);

router.get('/mypage/orders', async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { userId: req.authUser!.id },
    include: { orderItems: true },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    orders: orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      totalAmount: order.totalAmount,
      paymentStatus: order.paymentStatus,
      orderStatus: order.orderStatus,
      paidAt: order.paidAt,
      createdAt: order.createdAt,
      items: order.orderItems.map((item) => ({
        productName: item.productName,
        variantName: item.variantName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        subtotal: item.subtotal,
      })),
    })),
  });
});

router.get('/mypage/nfts', async (req, res) => {
  const nftIssues = await prisma.nftIssue.findMany({
    where: { userId: req.authUser!.id },
    include: { product: true, variant: true, order: true },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    nftIssues: nftIssues.map((issue) => ({
      id: issue.id,
      orderNumber: issue.order.orderNumber,
      productName: issue.product.name,
      variantName: issue.variant?.name ?? null,
      status: issue.status,
      tokenId: issue.tokenId,
      transactionHash: issue.transactionHash,
      issuedAt: issue.issuedAt,
    })),
  });
});

router.get('/mypage/wallet', async (req, res) => {
  const wallet = await prisma.wallet.findUnique({ where: { userId: req.authUser!.id } });
  res.json({ wallet: wallet ? { walletAddress: wallet.walletAddress, chain: wallet.chain } : null });
});

// ウォレット登録・更新時にstatus=wallet_requiredのnft_issuesをready_to_issueへ一括更新し、
// walletAddressをスナップショット保存する(仕様書v1.5 4.11)。issued/failedは変更しない。
router.post('/mypage/wallet', async (req, res) => {
  const { walletAddress, chain } = req.body ?? {};

  if (typeof walletAddress !== 'string' || !WALLET_ADDRESS_RE.test(walletAddress)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ウォレットアドレスの形式が正しくありません');
  }
  if (chain !== undefined && chain !== 'polygon') {
    return sendError(res, 400, 'VALIDATION_ERROR', '現在はPolygonのみ対応しています');
  }

  const userId = req.authUser!.id;

  const wallet = await prisma.$transaction(async (tx) => {
    const upserted = await tx.wallet.upsert({
      where: { userId },
      update: { walletAddress, chain: 'polygon' },
      create: { userId, walletAddress, chain: 'polygon' },
    });

    await tx.nftIssue.updateMany({
      where: { userId, status: 'wallet_required' },
      data: { status: 'ready_to_issue', walletAddress },
    });

    return upserted;
  });

  res.json({ wallet: { walletAddress: wallet.walletAddress, chain: wallet.chain } });
});

router.get('/mypage/notices', async (_req, res) => {
  const notices = await prisma.notice.findMany({
    where: { status: 'published' },
    orderBy: { publishedAt: 'desc' },
  });

  res.json({
    notices: notices.map((notice) => ({
      id: notice.id,
      title: notice.title,
      body: notice.body,
      publishedAt: notice.publishedAt,
    })),
  });
});

export default router;
