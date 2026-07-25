import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/apiError';
import { requireAuth } from '../middleware/auth';
import { HttpError } from '../lib/httpError';
import { pushAgencyCandidateToExternalSystem } from '../services/externalAgencySystem';
import { createWalletVerificationChallenge, verifyAndRegisterWallet } from '../services/walletVerification';
import { reissueWalletClaimToken } from '../services/walletClaim';
import { getWalletClaimWebBaseUrl } from '../services/walletClaimConfig';

const router = Router();

const WALLET_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

router.use(requireAuth);

router.get('/orders', async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { userId: req.authUser!.id },
    include: { orderItems: true },
    orderBy: { createdAt: 'desc' },
  });

  // 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)7章「マイページ状態」。
  const walletClaims = await prisma.walletClaim.findMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
  const walletClaimByOrderId = new Map(walletClaims.map((c) => [c.orderId, c]));

  res.json({
    orders: orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      totalAmount: order.totalAmount,
      paymentStatus: order.paymentStatus,
      orderStatus: order.orderStatus,
      paidAt: order.paidAt,
      createdAt: order.createdAt,
      walletClaim: (() => {
        const c = walletClaimByOrderId.get(order.id);
        return c ? { status: c.status, expiresAt: c.expiresAt } : null;
      })(),
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

  // 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)7章「マイページ状態」。
  // 生トークンは表示しない(このAPIは状態のみを返す。URLは/wallet-claim/reissueで発行する)。
  const walletClaim = await prisma.walletClaim.findUnique({ where: { orderId: order.id } });

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
      walletClaim: walletClaim ? { status: walletClaim.status, expiresAt: walletClaim.expiresAt } : null,
    },
  });
});

// 戦国マーケット NFTカード受取・送付 実装指示書(2026-07-25)6・7章: マイページの
// 「NFTカードを受け取る」/「受取URLを再発行」操作。生トークンは注文確定時のメール以外では
// 保存されないため、このAPIを呼ぶたびに新しいトークンを発行する(未使用の旧トークンは
// 自動的に無効化される)。ENABLE_WALLET_CLAIMが無効・対象注文でない・既にCLAIMED以降まで
// 進んでいる場合はURLを返せない。
router.post('/orders/:id/wallet-claim/reissue', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order || order.userId !== req.authUser!.id) {
    return sendError(res, 404, 'ORDER_NOT_FOUND', '注文が見つかりません');
  }

  const token = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, order.id));
  if (!token) {
    return sendError(res, 400, 'WALLET_CLAIM_NOT_REISSUABLE', '受取URLを発行できる状態ではありません');
  }

  const base = await getWalletClaimWebBaseUrl();
  if (!base) {
    return sendError(res, 503, 'WALLET_CLAIM_URL_NOT_CONFIGURED', '受取URLの設定が完了していません');
  }

  res.json({ url: `${base}/claim/${token}` });
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

// 仕様書外の拡張: 会員が代理店(インフルエンサー)への昇格を外部代理店システムへ申請する。
// 申請自体はsengoku-ai.com側で審査・承認され、承認結果は階層取得APIの定期同期で反映される。
router.post('/agency-application', async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.authUser!.id } });

  if (user.role !== 'user') {
    return sendError(res, 400, 'ALREADY_AGENCY_OR_ADMIN', '既に代理店または管理者権限を持つアカウントです');
  }
  if (user.agencyApplicationSubmittedAt) {
    return sendError(res, 400, 'APPLICATION_ALREADY_SUBMITTED', '既に代理店申請済みです。承認をお待ちください');
  }

  let parentExternalId: string | null = null;
  if (user.referredByAgencyId) {
    const referringAgency = await prisma.agency.findUnique({ where: { id: user.referredByAgencyId } });
    parentExternalId = referringAgency?.externalId ?? null;
  }

  try {
    await pushAgencyCandidateToExternalSystem({
      externalId: user.id,
      name: user.name,
      contactName: user.name,
      contactEmail: user.email,
      loginEmail: user.email,
      phone: user.phone,
      parentExternalId,
    });
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }

  await prisma.user.update({ where: { id: user.id }, data: { agencyApplicationSubmittedAt: new Date() } });

  res.status(201).json({ ok: true });
});

router.get('/wallet', async (req, res) => {
  const wallet = await prisma.wallet.findUnique({ where: { userId: req.authUser!.id } });
  res.json({
    wallet: wallet
      ? { walletAddress: wallet.walletAddress, chain: wallet.chain, verified: wallet.verified, verifiedAt: wallet.verifiedAt }
      : null,
  });
});

// 仕様書外の拡張: ウォレット所有確認(署名検証)のための使い捨て確認コードを発行する。
// クライアントはこのメッセージをブラウザのウォレット拡張機能(personal_sign)で署名し、
// POST /walletへ送る。
router.post('/wallet/nonce', async (req, res) => {
  const { walletAddress } = req.body ?? {};

  if (typeof walletAddress !== 'string' || !WALLET_ADDRESS_RE.test(walletAddress)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ウォレットアドレスの形式が正しくありません');
  }

  const challenge = await prisma.$transaction((tx) => createWalletVerificationChallenge(tx, req.authUser!.id, walletAddress));
  res.json(challenge);
});

// ウォレット登録・更新は署名検証を通過した場合のみ確定する(仕様書外の拡張)。
// 検証成功時、status=wallet_requiredのnft_issuesをready_to_issueへ一括更新し、
// walletAddressをスナップショット保存する(仕様書v1.5 4.11)。issued/failedは変更しない。
router.post('/wallet', async (req, res) => {
  const { walletAddress, signature } = req.body ?? {};

  if (typeof walletAddress !== 'string' || !WALLET_ADDRESS_RE.test(walletAddress)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'ウォレットアドレスの形式が正しくありません');
  }
  if (typeof signature !== 'string' || signature.trim().length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', '署名が見つかりません');
  }

  const userId = req.authUser!.id;

  try {
    const wallet = await prisma.$transaction((tx) => verifyAndRegisterWallet(tx, { userId, walletAddress, signature }));
    res.json({
      wallet: { walletAddress: wallet.walletAddress, chain: wallet.chain, verified: wallet.verified, verifiedAt: wallet.verifiedAt },
    });
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }
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
