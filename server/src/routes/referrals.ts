import { Router } from 'express';
import { dbRateLimit } from '../middleware/dbRateLimit';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/apiError';

const router = Router();

// 残課題指示書Stage12: 複数Vercelインスタンス間で回数が共有されるDB永続化型のレート制限に
// 差し替える。コード総当たりによるマスタ列挙を防ぐ(仕様書v1.5 13章)。特定の紹介コードへ
// 試行が集中するのを防ぐため、コード自体も識別子に加える。
const resolveLimiter = dbRateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  scope: 'referral-resolve',
  identify: (req) => (typeof req.query.code === 'string' ? req.query.code.toUpperCase() : undefined),
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
