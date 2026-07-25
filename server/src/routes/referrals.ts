import { Router } from 'express';
import { dbRateLimit } from '../middleware/dbRateLimit';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/apiError';
import { hashRateLimitIdentifier } from '../services/rateLimiter';

const router = Router();

// 残課題指示書Stage12/本番安定化指示書Stage3: 複数Vercelインスタンス間で回数が共有される
// DB永続化型のレート制限に差し替える。コード総当たりによるマスタ列挙を防ぐ(仕様書v1.5 13章)。
// IP単独・紹介コード単独の2bucketを独立して検査する(6.2の例どおり、referralはIP+コードの
// 複合bucketは作らない)。IP単独bucketは、同じ店舗・オフィス等から複数の異なる紹介コードを
// 閲覧する正当な利用(1つの紹介コードへの総当たりとは別の話)を過剰にブロックしないよう、
// コード単独より緩めにする。
const resolveLimiter = dbRateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  ipLimit: 30,
  scope: 'referral-resolve',
  identify: (req) => (typeof req.query.code === 'string' ? hashRateLimitIdentifier(req.query.code) : undefined),
  includeCombinedBucket: false,
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
