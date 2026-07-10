import crypto from 'crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { isValidEmail } from '../../lib/validation';
import { createPasswordResetToken } from '../../services/passwordReset';
import { sendAdminAccountSetupEmail } from '../../services/mailTemplates';

const router = Router();

const ADMIN_ROLES = ['admin', 'admin_viewer', 'staff'] as const;
type AdminRole = (typeof ADMIN_ROLES)[number];

const ROLE_LABEL: Record<AdminRole, string> = { admin: '管理者', admin_viewer: '閲覧専用管理者', staff: 'スタッフ' };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

// 仕様書外の拡張: 管理者アカウントの一覧・追加・権限変更(admin/admin_viewer/staffの3段階)。
router.get('/admin-users', async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { role: { in: [...ADMIN_ROLES] } },
    orderBy: { createdAt: 'asc' },
  });

  res.json({
    adminUsers: users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt })),
  });
});

router.post('/admin-users', async (req, res) => {
  const { name, email, role } = req.body ?? {};

  if (!isNonEmptyString(name)) return sendError(res, 400, 'VALIDATION_ERROR', '氏名を入力してください');
  if (!isNonEmptyString(email) || !isValidEmail(email)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'メールアドレスを正しく入力してください');
  }
  if (!ADMIN_ROLES.includes(role)) {
    return sendError(res, 400, 'VALIDATION_ERROR', '権限は管理者・閲覧専用管理者・スタッフのいずれかを指定してください');
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return sendError(res, 409, 'EMAIL_ALREADY_EXISTS', 'このメールアドレスは既に登録されています');
  }

  // 仮パスワードは平文で扱わずランダム値をハッシュ化するのみ(仕様書v1.5 16章の原則)。
  // 本人はパスワード設定メールのリンクから初期設定する。
  const user = await prisma.user.create({
    data: {
      name: name.trim(),
      email: email.trim(),
      passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
      role,
    },
  });

  const token = await createPasswordResetToken(user.id);
  await sendAdminAccountSetupEmail(user.email, user.name, token, ROLE_LABEL[role as AdminRole]);

  res.status(201).json({ adminUser: { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt } });
});

router.put('/admin-users/:id/role', async (req, res) => {
  const { role } = req.body ?? {};
  if (!ADMIN_ROLES.includes(role)) {
    return sendError(res, 400, 'VALIDATION_ERROR', '権限は管理者・閲覧専用管理者・スタッフのいずれかを指定してください');
  }

  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target || !ADMIN_ROLES.includes(target.role as AdminRole)) {
    return sendError(res, 404, 'ADMIN_USER_NOT_FOUND', '管理者アカウントが見つかりません');
  }

  // 自分自身の権限変更を禁止しているため、この操作を行える時点で操作者自身が
  // 別に存在するadminであることが保証され、最後の管理者を閲覧専用にしてしまう事態は起こらない。
  if (target.id === req.authUser!.id) {
    return sendError(res, 400, 'CANNOT_CHANGE_OWN_ROLE', '自分自身の権限は変更できません。別の管理者に依頼してください');
  }

  const updated = await prisma.user.update({ where: { id: target.id }, data: { role } });
  res.json({ adminUser: { id: updated.id, name: updated.name, email: updated.email, role: updated.role, createdAt: updated.createdAt } });
});

// 仕様書外の拡張: メール未達等でパスワード設定リンクが届いていない場合に、
// 新しいトークンを発行して設定メールを再送する。
router.post('/admin-users/:id/resend-setup-email', async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target || !ADMIN_ROLES.includes(target.role as AdminRole)) {
    return sendError(res, 404, 'ADMIN_USER_NOT_FOUND', '管理者アカウントが見つかりません');
  }

  const token = await createPasswordResetToken(target.id);
  await sendAdminAccountSetupEmail(target.email, target.name, token, ROLE_LABEL[target.role as AdminRole]);

  res.json({ success: true });
});

router.delete('/admin-users/:id', async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target || !ADMIN_ROLES.includes(target.role as AdminRole)) {
    return sendError(res, 404, 'ADMIN_USER_NOT_FOUND', '管理者アカウントが見つかりません');
  }

  if (target.id === req.authUser!.id) {
    return sendError(res, 400, 'CANNOT_DELETE_SELF', '自分自身のアカウントは削除できません。別の管理者に依頼してください');
  }

  // password_reset_tokens/notice_readsはUserへの物理FKがあるため、削除前に関連行を消す。
  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.deleteMany({ where: { userId: target.id } });
    await tx.noticeRead.deleteMany({ where: { userId: target.id } });
    await tx.user.delete({ where: { id: target.id } });
  });

  res.json({ success: true });
});

export default router;
