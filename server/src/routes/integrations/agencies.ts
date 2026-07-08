import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { sendIntegrationError } from '../../lib/apiError';
import { generateAgencyCode } from '../../services/referralCodeGenerator';
import { createPasswordResetToken } from '../../services/passwordReset';
import { sendAgencyAccountSetupEmail, sendAgencyAccessGrantedEmail } from '../../services/mailTemplates';
import { isValidEmail } from '../../lib/validation';

const router = Router();

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function serializeAgency(agency: {
  id: string;
  externalId: string | null;
  name: string;
  code: string;
  status: string;
  defaultCommissionRate: { toNumber(): number };
  contactName: string | null;
  contactEmail: string | null;
  pendingParentExternalId: string | null;
  parentAgency: { externalId: string | null } | null;
}) {
  return {
    id: agency.id,
    external_id: agency.externalId,
    name: agency.name,
    code: agency.code,
    status: agency.status,
    default_commission_rate: agency.defaultCommissionRate.toNumber(),
    contact_name: agency.contactName,
    contact_email: agency.contactEmail,
    // 親が未解決(先方仕様書v3.6.40)の間は、受け取ったexternal_idをそのまま返す。
    parent_external_id: agency.parentAgency?.externalId ?? agency.pendingParentExternalId ?? null,
  };
}

// proposedParentIdを親にすると、targetAgencyId自身がその祖先に含まれてしまう(循環)かどうかを判定する。
async function wouldCreateCycle(targetAgencyId: string, proposedParentId: string): Promise<boolean> {
  let currentId: string | null = proposedParentId;
  while (currentId) {
    if (currentId === targetAgencyId) return true;
    const current: { parentAgencyId: string | null } | null = await prisma.agency.findUnique({
      where: { id: currentId },
      select: { parentAgencyId: true },
    });
    currentId = current?.parentAgencyId ?? null;
  }
  return false;
}

async function findAgencyDetail(externalId: string) {
  const agency = await prisma.agency.findUnique({
    where: { externalId },
    include: { parentAgency: { select: { externalId: true } }, childAgencies: { select: { externalId: true } } },
  });
  if (!agency) return null;

  return {
    ...serializeAgency(agency),
    child_external_ids: agency.childAgencies.map((c) => c.externalId).filter((id): id is string => id !== null),
  };
}

router.get('/', async (req, res) => {
  // サーバー設定によりパス形式(/:externalId)が使えない呼び出し元向けに、クエリ形式でも詳細取得できるようにする。
  const queryExternalId = req.query.external_id;
  if (typeof queryExternalId === 'string' && queryExternalId.length > 0) {
    const detail = await findAgencyDetail(queryExternalId);
    if (!detail) return sendIntegrationError(res, 404, 'Agency not found');
    return res.json({ agency: detail });
  }

  const agencies = await prisma.agency.findMany({
    include: { parentAgency: { select: { externalId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ agencies: agencies.map(serializeAgency) });
});

router.get('/:externalId', async (req, res) => {
  const detail = await findAgencyDetail(req.params.externalId);
  if (!detail) return sendIntegrationError(res, 404, 'Agency not found');
  res.json({ agency: detail });
});

router.post('/', async (req, res) => {
  const {
    external_id: externalId,
    name,
    parent_external_id: parentExternalId,
    default_commission_rate: defaultCommissionRate,
    contact_name: contactName,
    contact_email: contactEmail,
    status,
    login_email: loginEmail,
  } = req.body ?? {};

  if (!isNonEmptyString(externalId)) {
    return sendIntegrationError(res, 422, 'external_id is required');
  }
  if (!isNonEmptyString(name)) {
    return sendIntegrationError(res, 422, 'name is required');
  }
  if (
    defaultCommissionRate !== undefined &&
    defaultCommissionRate !== null &&
    (typeof defaultCommissionRate !== 'number' || defaultCommissionRate < 0 || defaultCommissionRate > 100)
  ) {
    return sendIntegrationError(res, 422, 'default_commission_rate must be a number between 0 and 100');
  }
  if (status !== undefined && status !== 'active' && status !== 'inactive') {
    return sendIntegrationError(res, 422, 'status must be "active" or "inactive"');
  }
  if (loginEmail !== undefined && loginEmail !== null && !isValidEmail(loginEmail)) {
    return sendIntegrationError(res, 422, 'login_email is invalid');
  }

  try {
    const existing = await prisma.agency.findUnique({ where: { externalId } });

    // parent_external_id: 未指定なら現状維持(新規なら本部直下)、null/空文字は本部直下への解除。
    let parentAgencyId: string | null | undefined;
    let pendingParentExternalId: string | null | undefined;
    if (parentExternalId === null || parentExternalId === '') {
      parentAgencyId = null;
      pendingParentExternalId = null;
    } else if (parentExternalId !== undefined) {
      if (!isNonEmptyString(parentExternalId)) {
        return sendIntegrationError(res, 422, 'parent_external_id is invalid');
      }
      if (parentExternalId === externalId) {
        return sendIntegrationError(res, 422, 'Cannot set itself as parent_external_id');
      }
      const parent = await prisma.agency.findUnique({ where: { externalId: parentExternalId } });
      if (!parent) {
        // 仕様書v3.6.40: 親が未登録の場合はエラーにせず、external_idを未解決のまま保存し、
        // 親レコードが後から届いた時点で自動的に再紐付けする(下記の再紐付け処理を参照)。
        parentAgencyId = null;
        pendingParentExternalId = parentExternalId;
      } else {
        if (existing) {
          const cyclic = await wouldCreateCycle(existing.id, parent.id);
          if (cyclic) {
            return sendIntegrationError(res, 422, 'Cannot set a descendant agency as parent_external_id');
          }
        }
        parentAgencyId = parent.id;
        pendingParentExternalId = null;
      }
    } else if (!existing && isNonEmptyString(loginEmail)) {
      // 仕様書外の拡張: 新規代理店作成時にparent_external_idの指定がなく、login_emailが
      // 「このサイトで購入経験があり、既に代理店へ永久帰属しているユーザー」のメールアドレスと
      // 一致する場合、その元の代理店(紹介者)を上位代理店として自動継承する。
      // (例: 評議員NFTを購入した会員がインフルエンサー申請を経て代理店に昇格するケース)
      const referredUser = await prisma.user.findUnique({ where: { email: loginEmail } });
      if (referredUser?.referredByAgencyId) {
        parentAgencyId = referredUser.referredByAgencyId;
      }
    }

    const agency = existing
      ? await prisma.agency.update({
          where: { id: existing.id },
          data: {
            name,
            parentAgencyId,
            pendingParentExternalId,
            defaultCommissionRate: defaultCommissionRate ?? undefined,
            contactName: contactName ?? undefined,
            contactEmail: contactEmail ?? undefined,
            status: status ?? undefined,
          },
          include: { parentAgency: { select: { externalId: true } } },
        })
      : await prisma.$transaction(async (tx) => {
          const code = await generateAgencyCode(tx);
          return tx.agency.create({
            data: {
              externalId,
              name,
              code,
              parentAgencyId: parentAgencyId ?? null,
              pendingParentExternalId: pendingParentExternalId ?? null,
              defaultCommissionRate: defaultCommissionRate ?? 0,
              // contact_name未指定時はnameを使う(相手仕様書5章のフィールド説明に合わせる)。
              contactName: contactName ?? name,
              contactEmail: contactEmail ?? null,
              status: status ?? 'active',
            },
            include: { parentAgency: { select: { externalId: true } } },
          });
        });

    // 仕様書v3.6.40: このexternal_idを親として待っていた代理店(未解決のまま保存されていた子)を再紐付けする。
    await prisma.agency.updateMany({
      where: { pendingParentExternalId: externalId },
      data: { parentAgencyId: agency.id, pendingParentExternalId: null },
    });

    let loginProvisioned = false;
    if (isNonEmptyString(loginEmail)) {
      const alreadyHasLogin = await prisma.user.findFirst({ where: { agencyId: agency.id, role: 'agency' } });
      if (!alreadyHasLogin) {
        const existingUserByEmail = await prisma.user.findUnique({ where: { email: loginEmail } });

        if (existingUserByEmail) {
          // 既に代理店ポータル・管理者として使われているアカウントは横取りしない。
          if (['agency', 'admin', 'admin_viewer'].includes(existingUserByEmail.role)) {
            return sendIntegrationError(res, 409, 'login_email is already used by another admin/agency account');
          }

          // 仕様書外の拡張: 既存の一般会員アカウント(評議員NFT購入者等)を代理店ポータルログインに
          // 昇格させる。既にパスワードを持っているため、仮パスワードの再発行・設定メールは不要。
          await prisma.user.update({
            where: { id: existingUserByEmail.id },
            data: { role: 'agency', agencyId: agency.id },
          });
          await sendAgencyAccessGrantedEmail(existingUserByEmail.email, existingUserByEmail.name);
        } else {
          const user = await prisma.user.create({
            data: {
              name: agency.contactName ?? agency.name,
              email: loginEmail,
              // 仮パスワードは平文で扱わずランダム値をハッシュ化するのみ(仕様書v1.5 16章の原則を踏襲)。
              // 本人はパスワード再設定メールのリンクから初期設定する。
              passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
              role: 'agency',
              agencyId: agency.id,
            },
          });
          const token = await createPasswordResetToken(user.id);
          await sendAgencyAccountSetupEmail(user.email, user.name, token);
        }
        loginProvisioned = true;
      }
    }

    // レスポンス形式は先方仕様書v3.6.40の{success, data}エンベロープに合わせる。
    res.status(existing ? 200 : 201).json({
      success: true,
      data: { ...serializeAgency(agency), login_provisioned: loginProvisioned, synced: true },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return sendIntegrationError(res, 409, 'login_email is already in use');
    }
    throw e;
  }
});

export default router;
