import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/apiError';
import { requireAuth } from '../middleware/auth';

const router = Router();

const WALLET_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

router.use(requireAuth);

router.get('/orders', async (req, res) => {
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

// 仕様書外の拡張: 領収書表示用に自分の注文を1件だけ取得する。
router.get('/orders/:id', async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { orderItems: true },
  });

  if (!order || order.userId !== req.authUser!.id) {
    return sendError(res, 404, 'ORDER_NOT_FOUND', '注文が見つかりません');
  }

  res.json({
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      totalAmount: order.totalAmount,
      paymentStatus: order.paymentStatus,
      orderStatus: order.orderStatus,
      customerName: order.customerName,
      paidAt: order.paidAt,
      createdAt: order.createdAt,
      items: order.orderItems.map((item) => ({
        productName: item.productName,
        variantName: item.variantName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        subtotal: item.subtotal,
      })),
    },
  });
});

router.get('/nfts', async (req, res) => {
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

// 仕様書外の拡張: 会員が自分の氏名・電話番号を編集できるようにする。
// メールアドレスはログインIDを兼ねる(再認証フローが必要になるため対象外)。
router.put('/profile', async (req, res) => {
  const { name, phone } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', '氏名を入力してください');
  }
  if (phone !== undefined && phone !== null && typeof phone !== 'string') {
    return sendError(res, 400, 'VALIDATION_ERROR', '電話番号の形式が正しくありません');
  }

  const user = await prisma.user.update({
    where: { id: req.authUser!.id },
    data: {
      name: name.trim(),
      phone: typeof phone === 'string' && phone.trim().length > 0 ? phone.trim() : null,
    },
  });

  res.json({ user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role, agencyId: user.agencyId } });
});

router.get('/wallet', async (req, res) => {
  const wallet = await prisma.wallet.findUnique({ where: { userId: req.authUser!.id } });
  res.json({ wallet: wallet ? { walletAddress: wallet.walletAddress, chain: wallet.chain } : null });
});

// ウォレット登録・更新時にstatus=wallet_requiredのnft_issuesをready_to_issueへ一括更新し、
// walletAddressをスナップショット保存する(仕様書v1.5 4.11)。issued/failedは変更しない。
router.post('/wallet', async (req, res) => {
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

router.get('/notices', async (req, res) => {
  const userId = req.authUser!.id;
  const [notices, reads] = await Promise.all([
    prisma.notice.findMany({
      where: { status: 'published' },
      orderBy: { publishedAt: 'desc' },
    }),
    prisma.noticeRead.findMany({ where: { userId }, select: { noticeId: true } }),
  ]);
  const readNoticeIds = new Set(reads.map((r) => r.noticeId));

  res.json({
    notices: notices.map((notice) => ({
      id: notice.id,
      title: notice.title,
      body: notice.body,
      publishedAt: notice.publishedAt,
      read: readNoticeIds.has(notice.id),
    })),
  });
});

// 仕様書外の拡張: お知らせの既読管理(会員単位)。
router.post('/notices/:id/read', async (req, res) => {
  const userId = req.authUser!.id;
  const notice = await prisma.notice.findUnique({ where: { id: req.params.id } });
  if (!notice || notice.status !== 'published') {
    return sendError(res, 404, 'NOTICE_NOT_FOUND', 'お知らせが見つかりません');
  }

  await prisma.noticeRead.upsert({
    where: { userId_noticeId: { userId, noticeId: notice.id } },
    update: {},
    create: { userId, noticeId: notice.id },
  });

  res.json({ ok: true });
});

export default router;
