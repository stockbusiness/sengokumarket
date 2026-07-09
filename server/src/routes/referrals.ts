import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/apiError';

const router = Router();

// コード総当たりによるマスタ列挙を防ぐ(仕様書v1.5 13章)
const resolveLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/referrals/resolve', resolveLimiter, async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
  if (!code) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'codeを指定してください');
  }

  const link = await prisma.referralLink.findFirst({
    where: { code, status: 'active' },
    include: { agency: true, influencer: true, coupon: true },
  });

  if (!link) {
    return res.json({ found: false });
  }

  res.json({
    found: true,
    referrerName: link.influencer?.name ?? link.agency?.name ?? null,
    // 仕様書外の拡張(クーポン機能): 自動適用クーポンがあれば購入画面側でプレビュー表示に使う。
    autoApplyCouponCode: link.couponAutoApply ? (link.coupon?.code ?? null) : null,
  });
});

export default router;
