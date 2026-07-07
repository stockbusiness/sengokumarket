import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/apiError';
import { isValidEmail } from '../lib/validation';
import { signAuthToken } from '../services/jwt';
import { setAuthCookie, clearAuthCookie } from '../lib/authCookie';
import { isLocked, recordLoginFailure, recordLoginSuccess } from '../services/loginAttempts';
import { requireAuth } from '../middleware/auth';
import { createPasswordResetToken, consumePasswordResetToken } from '../services/passwordReset';
import { sendPasswordResetEmail } from '../services/mailTemplates';

const router = Router();

// 大量アカウント作成・パスワード再設定メール送信の踏み台化を防ぐ(仕様書外の拡張)。
const registerLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const passwordResetRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function publicUser(user: { id: string; name: string; email: string; phone?: string | null; role: string; agencyId?: string | null }) {
  return { id: user.id, name: user.name, email: user.email, phone: user.phone ?? null, role: user.role, agencyId: user.agencyId ?? null };
}

router.post('/auth/register', registerLimiter, async (req, res) => {
  const { name, email, password, phone } = req.body ?? {};

  if (!isNonEmptyString(name)) return sendError(res, 400, 'VALIDATION_ERROR', '氏名を入力してください');
  if (!isNonEmptyString(email) || !isValidEmail(email)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'メールアドレスを正しく入力してください');
  }
  if (!isNonEmptyString(password) || password.length < 8) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'パスワードは8文字以上で入力してください');
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return sendError(res, 409, 'EMAIL_ALREADY_EXISTS', 'このメールアドレスは既に登録されています');
  }

  const user = await prisma.user.create({
    data: {
      name,
      email,
      phone: isNonEmptyString(phone) ? phone : null,
      passwordHash: await bcrypt.hash(password, 10),
      role: 'user',
    },
  });

  const token = signAuthToken({ sub: user.id, role: user.role });
  setAuthCookie(res, token);
  res.status(201).json({ user: publicUser(user) });
});

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  const ip = req.ip ?? 'unknown';

  if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'メールアドレスとパスワードを入力してください');
  }

  if (await isLocked(email, ip)) {
    return sendError(res, 423, 'ACCOUNT_LOCKED', 'ログイン試行回数の上限に達しました。しばらくしてから再度お試しください');
  }

  const user = await prisma.user.findUnique({ where: { email } });
  const passwordOk = user ? await bcrypt.compare(password, user.passwordHash) : false;

  if (!user || !passwordOk) {
    await recordLoginFailure(email, ip);
    return sendError(res, 401, 'INVALID_CREDENTIALS', 'メールアドレスまたはパスワードが正しくありません');
  }

  await recordLoginSuccess(email, ip);
  const token = signAuthToken({ sub: user.id, role: user.role, agencyId: user.agencyId ?? undefined });
  setAuthCookie(res, token);
  res.json({ user: publicUser(user) });
});

router.post('/auth/logout', (_req, res) => {
  clearAuthCookie(res);
  res.status(200).json({ ok: true });
});

router.get('/auth/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.authUser!.id } });
  if (!user) return sendError(res, 401, 'UNAUTHENTICATED', 'ログインが必要です');
  res.json({ user: publicUser(user) });
});

// メールアドレスの存在有無を返さない(仕様書v1.5 4.8 / 16章)。常に同一レスポンスを返す。
router.post('/auth/password-reset/request', passwordResetRequestLimiter, async (req, res) => {
  const { email } = req.body ?? {};
  if (isNonEmptyString(email) && isValidEmail(email)) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      const token = await createPasswordResetToken(user.id);
      await sendPasswordResetEmail(user.email, user.name, token);
    }
  }
  res.json({ message: 'パスワード再設定用のメールを送信しました(該当するアカウントが存在する場合)' });
});

// ゲスト購入時のパスワード設定リンクと共用のエンドポイント(仕様書v1.5 4.9 / 6.10)。
router.post('/auth/password-reset/confirm', async (req, res) => {
  const { token, newPassword } = req.body ?? {};
  if (!isNonEmptyString(token) || !isNonEmptyString(newPassword) || newPassword.length < 8) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'トークンと8文字以上の新しいパスワードを指定してください');
  }

  const ok = await consumePasswordResetToken(token, newPassword);
  if (!ok) {
    return sendError(res, 400, 'INVALID_OR_EXPIRED_TOKEN', 'トークンが無効または期限切れです');
  }
  res.json({ ok: true });
});

export default router;
