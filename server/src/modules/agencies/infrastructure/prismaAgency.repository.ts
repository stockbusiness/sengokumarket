import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { Prisma, PrismaClient } from '@prisma/client';
import { emailFilterInsensitive, normalizeEmail } from '../../../lib/validation';
import type { AgencyDetail, AgencyRecord } from '../domain/agency.types';

// GET系の読取はPrismaClientそのまま、upsert系usecaseはトランザクション内のTransactionClientを渡す。
type Db = PrismaClient | Prisma.TransactionClient;

function toRecord(agency: {
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
}): AgencyRecord {
  return {
    id: agency.id,
    externalId: agency.externalId,
    name: agency.name,
    code: agency.code,
    status: agency.status,
    defaultCommissionRate: agency.defaultCommissionRate.toNumber(),
    contactName: agency.contactName,
    contactEmail: agency.contactEmail,
    parentExternalId: agency.parentAgency?.externalId ?? agency.pendingParentExternalId ?? null,
  };
}

// 存在確認・親解決に使う内部専用の取得(HTTP層へは公開しない)。
export function findAgencyByExternalId(db: Db, externalId: string) {
  return db.agency.findUnique({ where: { externalId } });
}

export async function findAgencyParentId(db: Db, agencyId: string): Promise<string | null> {
  const agency = await db.agency.findUnique({ where: { id: agencyId }, select: { parentAgencyId: true } });
  return agency?.parentAgencyId ?? null;
}

export async function listAgencies(db: Db): Promise<AgencyRecord[]> {
  const agencies = await db.agency.findMany({
    include: { parentAgency: { select: { externalId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return agencies.map(toRecord);
}

export async function findAgencyDetail(db: Db, externalId: string): Promise<AgencyDetail | null> {
  const agency = await db.agency.findUnique({
    where: { externalId },
    include: { parentAgency: { select: { externalId: true } }, childAgencies: { select: { externalId: true } } },
  });
  if (!agency) return null;

  return {
    ...toRecord(agency),
    childExternalIds: agency.childAgencies.map((c) => c.externalId).filter((id): id is string => id !== null),
  };
}

export interface CreateAgencyData {
  externalId: string;
  name: string;
  code: string;
  parentAgencyId: string | null;
  pendingParentExternalId: string | null;
  defaultCommissionRate: number;
  contactName: string;
  contactEmail: string | null;
  status: string;
}

export async function createAgency(db: Db, data: CreateAgencyData): Promise<AgencyRecord> {
  const agency = await db.agency.create({
    data,
    include: { parentAgency: { select: { externalId: true } } },
  });
  return toRecord(agency);
}

export interface UpdateAgencyData {
  name: string;
  parentAgencyId: string | null | undefined;
  pendingParentExternalId: string | null | undefined;
  defaultCommissionRate: number | undefined;
  contactName: string | undefined;
  contactEmail: string | undefined;
  status: string | undefined;
}

export async function updateAgency(db: Db, id: string, data: UpdateAgencyData): Promise<AgencyRecord> {
  const agency = await db.agency.update({
    where: { id },
    data,
    include: { parentAgency: { select: { externalId: true } } },
  });
  return toRecord(agency);
}

// このexternal_idを親として待っていた代理店(未解決のまま保存されていた子)を再紐付けする。
export async function reconcilePendingParents(db: Db, resolvedExternalId: string, resolvedAgencyId: string): Promise<void> {
  await db.agency.updateMany({
    where: { pendingParentExternalId: resolvedExternalId },
    data: { parentAgencyId: resolvedAgencyId, pendingParentExternalId: null },
  });
}

export function findLoginUserForAgency(db: Db, agencyId: string) {
  return db.user.findFirst({ where: { agencyId, role: 'agency' } });
}

// 仕様書外の拡張: メールアドレスの大文字小文字を区別しない。
export function findUserByEmailInsensitive(db: Db, email: string) {
  return db.user.findFirst({ where: { email: emailFilterInsensitive(email) } });
}

export async function findReferredByAgencyId(db: Db, email: string): Promise<string | null> {
  const user = await db.user.findFirst({ where: { email: emailFilterInsensitive(email) } });
  return user?.referredByAgencyId ?? null;
}

export function promoteUserToAgency(db: Db, userId: string, agencyId: string) {
  return db.user.update({ where: { id: userId }, data: { role: 'agency', agencyId } });
}

export async function createAgencyLoginUser(db: Db, data: { name: string; email: string; agencyId: string }) {
  return db.user.create({
    data: {
      name: data.name,
      email: normalizeEmail(data.email),
      // 仮パスワードは平文で扱わずランダム値をハッシュ化するのみ(仕様書v1.5 16章の原則を踏襲)。
      // 本人はパスワード再設定メールのリンクから初期設定する。
      passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
      role: 'agency',
      agencyId: data.agencyId,
    },
  });
}
