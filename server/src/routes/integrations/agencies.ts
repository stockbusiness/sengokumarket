import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { sendError } from '../../lib/apiError';
import { generateAgencyCode } from '../../services/referralCodeGenerator';
import { createPasswordResetToken } from '../../services/passwordReset';
import { sendAgencyAccountSetupEmail } from '../../services/mailTemplates';
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
    parent_external_id: agency.parentAgency?.externalId ?? null,
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
    if (!detail) return sendError(res, 404, 'AGENCY_NOT_FOUND', '代理店が見つかりません');
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
  if (!detail) return sendError(res, 404, 'AGENCY_NOT_FOUND', '代理店が見つかりません');
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
    return sendError(res, 400, 'VALIDATION_ERROR', 'external_idを指定してください');
  }
  if (!isNonEmptyString(name)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'nameを指定してください');
  }
  if (
    defaultCommissionRate !== undefined &&
    defaultCommissionRate !== null &&
    (typeof defaultCommissionRate !== 'number' || defaultCommissionRate < 0 || defaultCommissionRate > 100)
  ) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'default_commission_rateは0〜100の数値で指定してください');
  }
  if (status !== undefined && status !== 'active' && status !== 'inactive') {
    return sendError(res, 400, 'VALIDATION_ERROR', 'statusはactiveまたはinactiveを指定してください');
  }
  if (loginEmail !== undefined && loginEmail !== null && !isValidEmail(loginEmail)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'login_emailの形式が正しくありません');
  }

  try {
    const existing = await prisma.agency.findUnique({ where: { externalId } });

    // parent_external_id: 未指定なら現状維持(新規なら本部直下)、null/空文字は本部直下への解除。
    let parentAgencyId: string | null | undefined;
    if (parentExternalId === null || parentExternalId === '') {
      parentAgencyId = null;
    } else if (parentExternalId !== undefined) {
      if (!isNonEmptyString(parentExternalId)) {
        return sendError(res, 400, 'VALIDATION_ERROR', 'parent_external_idの形式が正しくありません');
      }
      if (parentExternalId === externalId) {
        return sendError(res, 400, 'VALIDATION_ERROR', '自分自身を親代理店に指定することはできません');
      }
      const parent = await prisma.agency.findUnique({ where: { externalId: parentExternalId } });
      if (!parent) return sendError(res, 404, 'PARENT_AGENCY_NOT_FOUND', '親代理店が見つかりません(先に親を登録してください)');

      if (existing) {
        const cyclic = await wouldCreateCycle(existing.id, parent.id);
        if (cyclic) {
          return sendError(res, 400, 'VALIDATION_ERROR', '自分の配下代理店を親代理店に指定することはできません');
        }
      }
      parentAgencyId = parent.id;
    }

    const agency = existing
      ? await prisma.agency.update({
          where: { id: existing.id },
          data: {
            name,
            parentAgencyId,
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
              defaultCommissionRate: defaultCommissionRate ?? 0,
              // contact_name未指定時はnameを使う(相手仕様書5章のフィールド説明に合わせる)。
              contactName: contactName ?? name,
              contactEmail: contactEmail ?? null,
              status: status ?? 'active',
            },
            include: { parentAgency: { select: { externalId: true } } },
          });
        });

    let loginProvisioned = false;
    if (isNonEmptyString(loginEmail)) {
      const alreadyHasLogin = await prisma.user.findFirst({ where: { agencyId: agency.id, role: 'agency' } });
      if (!alreadyHasLogin) {
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
        loginProvisioned = true;
      }
    }

    res.status(existing ? 200 : 201).json({ agency: { ...serializeAgency(agency), login_provisioned: loginProvisioned } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return sendError(res, 409, 'LOGIN_EMAIL_ALREADY_EXISTS', 'このメールアドレスは既に使用されています');
    }
    throw e;
  }
});

export default router;
