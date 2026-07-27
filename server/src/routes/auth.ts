import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { sendError } from '../lib/apiError';
import { emailFilterInsensitive, isValidEmail, normalizeEmail } from '../lib/validation';
import { signAuthToken } from '../services/jwt';
import { setAuthCookie, clearAuthCookie } from '../lib/authCookie';
import { isLocked, recordLoginFailure, recordLoginSuccess } from '../services/loginAttempts';
import { requireAuth } from '../middleware/auth';
import { consumePasswordResetToken } from '../services/passwordReset';
import { verifyAndConsumeAgencySsoToken } from '../services/agencySso';
import { HttpError } from '../lib/httpError';
import { enqueueCommonUserResolveJob } from '../services/orderLinkingJobs';
import { dbRateLimit } from '../middleware/dbRateLimit';
import { hashRateLimitIdentifier } from '../services/rateLimiter';
import { enqueueNotification } from '../modules/notifications/infrastructure/notificationOutbox.repository';
import { triggerImmediateNotificationDispatch } from '../modules/notifications/application/dispatchNotificationOutbox.usecase';

const router = Router();

function hashedEmailIdentifier(req: Request): string | undefined {
  return typeof req.body?.email === 'string' ? hashRateLimitIdentifier(req.body.email) : undefined;
}

// 残課題指示書Stage12/本番安定化指示書Stage3: 複数Vercelインスタンス間で回数が共有される
// DB永続化型のレート制限に差し替える(express-rate-limitの既定MemoryStoreはインスタンスごとに
// 独立していた)。IP単独・メールアドレス単独・両方の複合の3bucketを独立して検査することで、
// IPを変えるだけ・メールアドレスを変えるだけでの回避を防ぐ(6.2)。IP単独bucketは社内
// ネットワーク等の共有IPからの正当な複数アカウント登録を過剰にブロックしないよう、
// メールアドレス単独bucketより緩めの上限にする(6.8「正常利用を過剰にブロックしない」)。
// 大量アカウント作成・パスワード再設定メール送信の踏み台化を防ぐ(仕様書外の拡張)。
const registerLimiter = dbRateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  ipLimit: 30,
  scope: 'register',
  identify: hashedEmailIdentifier,
});
const passwordResetRequestLimiter = dbRateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  ipLimit: 30,
  scope: 'password-reset-request',
  identify: hashedEmailIdentifier,
});
// トークン総当たり対策。トークン自体を識別子にすると攻撃者の目的(異なるトークンを大量に
// 試す)と矛盾するため、IPのみで制限する。
const passwordResetConfirmLimiter = dbRateLimit({ windowMs: 15 * 60 * 1000, limit: 20, scope: 'password-reset-confirm' });
const agencySsoLimiter = dbRateLimit({ windowMs: 15 * 60 * 1000, limit: 30, scope: 'agency-sso' });
// loginはisLocked/recordLoginFailure(login_attemptsテーブル、メールアドレス+IP単位)で
// 既にDB永続化・複数インスタンス間で共有される形のレート制限が掛かっている
// (express-rate-limitのMemoryStore問題は元々login以外の箇所の話であり、loginはこの
// 仕組みにより残課題指示書Stage12の受入条件を既に満たしている)。重ねて広いIP単位の
// 上限を掛けると、同一IPを共有する複数ユーザー(社内ネットワーク等)からの正常なログインを
// 過剰にブロックしてしまうため、あえて追加しない。

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function publicUser(user: {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  role: string;
  agencyId?: string | null;
  agencyApplicationSubmittedAt?: Date | null;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    role: user.role,
    agencyId: user.agencyId ?? null,
    agencyApplicationSubmittedAt: user.agencyApplicationSubmittedAt ?? null,
  };
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

  // 仕様書外の拡張: メールアドレスは大文字小文字を区別しない(User@example.comとuser@example.com
  // で別アカウントが作られてしまう問題の修正)。既存の混在データも拾えるようfindFirst+insensitiveで
  // 重複チェックし、新規登録は正規化(小文字化)して保存する。
  const existing = await prisma.user.findFirst({ where: { email: emailFilterInsensitive(email) } });
  if (existing) {
    return sendError(res, 409, 'EMAIL_ALREADY_EXISTS', 'このメールアドレスは既に登録されています');
  }

  // 仕様書外の拡張(千ノ国全体連携・残課題指示書Stage4対応): common_user_id解決はServerlessでの
  // fire-and-forgetをやめ、ユーザー作成と同一トランザクションで永続ジョブとして記録する
  // (外部HTTP呼び出し自体はcommit後にDispatcherが行う)。
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        name,
        email: normalizeEmail(email),
        phone: isNonEmptyString(phone) ? phone : null,
        passwordHash: await bcrypt.hash(password, 10),
        role: 'user',
      },
    });
    await enqueueCommonUserResolveJob(tx, { userId: created.id });
    return created;
  });

  const token = signAuthToken({ sub: user.id, role: user.role, sessionVersion: user.sessionVersion });
  setAuthCookie(res, token);
  res.status(201).json({ user: publicUser(user) });
  // 本番安定化指示書Stage1: common_user_id解決ジョブは登録と同一トランザクションで既に
  // 永続化済み(enqueueCommonUserResolveJob)。以前はレスポンス送信後にベストエフォートで
  // 即時ディスパッチを試みていたが、レスポンス送信後もサーバーレス関数の実行が外部API待ちで
  // 延びてしまうため廃止した。処理はCron(またはFeature Flag有効時の管理者による明示的な再送)に委ねる。
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

  const user = await prisma.user.findFirst({ where: { email: emailFilterInsensitive(email) } });
  const passwordOk = user ? await bcrypt.compare(password, user.passwordHash) : false;

  if (!user || !passwordOk) {
    await recordLoginFailure(email, ip);
    return sendError(res, 401, 'INVALID_CREDENTIALS', 'メールアドレスまたはパスワードが正しくありません');
  }

  await recordLoginSuccess(email, ip);
  const token = signAuthToken({
    sub: user.id,
    role: user.role,
    agencyId: user.agencyId ?? undefined,
    sessionVersion: user.sessionVersion,
  });
  setAuthCookie(res, token);
  res.json({ user: publicUser(user) });
});

// 仕様書外の拡張(先方仕様書v3.6.45準拠): 代理店システム(IdP)発行のSSOトークンを検証し、
// 対応する代理店ポータルアカウントで通常ログインと同じセッションを発行する。
router.post('/auth/agency-sso', agencySsoLimiter, async (req, res) => {
  const { token } = req.body ?? {};
  if (!isNonEmptyString(token)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'トークンを指定してください');
  }

  let result;
  try {
    result = await verifyAndConsumeAgencySsoToken(token);
  } catch (e) {
    if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
    throw e;
  }

  const user = await prisma.user.findUnique({ where: { id: result.userId } });
  if (!user) return sendError(res, 401, 'agency_not_linked', '代理店ポータルとの連携が見つかりません');

  const jwt = signAuthToken({
    sub: user.id,
    role: user.role,
    agencyId: user.agencyId ?? undefined,
    sessionVersion: user.sessionVersion,
  });
  setAuthCookie(res, jwt);
  res.json({ user: publicUser(user), returnTo: result.returnTo });
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
    const user = await prisma.user.findFirst({ where: { email: emailFilterInsensitive(email) } });
    if (user) {
      // Wallet Claim本番前安定化指示書(2026-07-25)Phase11(13.3「Tokenを含む通知」): 生Tokenは
      // Outbox payloadへ保存せず、Dispatcher実行時に発行する(agency_account_setupと同じ設計)。
      await enqueueNotification(prisma, {
        eventType: 'password_reset',
        recipient: user.email,
        payload: { name: user.name, userId: user.id },
      });
      await triggerImmediateNotificationDispatch();
    }
  }
  res.json({ message: 'パスワード再設定用のメールを送信しました(該当するアカウントが存在する場合)' });
});

// ゲスト購入時のパスワード設定リンクと共用のエンドポイント(仕様書v1.5 4.9 / 6.10)。
router.post('/auth/password-reset/confirm', passwordResetConfirmLimiter, async (req, res) => {
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
