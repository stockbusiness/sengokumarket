import type { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { generateAgencyCode } from '../../../services/referralCodeGenerator';
import * as repo from '../infrastructure/prismaAgency.repository';
import { wouldCreateCycle } from '../domain/agencyHierarchy.policy';
import { reconcilePendingParents } from './reconcilePendingParents.usecase';
import { provisionAgencyAccount } from './provisionAgencyAccount.usecase';
import { AgencyValidationError, type AgencyRecord, type UpsertAgencyRequest } from '../domain/agency.types';

type Tx = Prisma.TransactionClient;

export interface UpsertAgencyResult {
  agency: AgencyRecord;
  created: boolean;
  loginProvisioned: boolean;
}

interface ParentAssignment {
  parentAgencyId: string | null | undefined;
  pendingParentExternalId: string | null | undefined;
}

// 親代理店の解決: 指定なし(undefined)は現状維持(新規かつlogin_emailが既存の永久帰属先を
// 持つ場合はそれを継承)、null/空文字は本部直下への明示的な解除、有効なexternal_idは
// 解決する(未登録ならpending保存、既存代理店なら循環チェック後に確定)。
async function resolveParentAssignment(tx: Tx, input: UpsertAgencyRequest, existingId: string | null): Promise<ParentAssignment> {
  const { parentExternalId, externalId, loginEmail } = input;

  if (parentExternalId === null || parentExternalId === '') {
    return { parentAgencyId: null, pendingParentExternalId: null };
  }

  if (parentExternalId !== undefined) {
    if (parentExternalId === externalId) {
      throw new AgencyValidationError('Cannot set itself as parent_external_id.');
    }
    const parent = await repo.findAgencyByExternalId(tx, parentExternalId);
    if (!parent) {
      // 親が未登録の場合はエラーにせず、external_idを未解決のまま保存し、
      // 親レコードが後から届いた時点で自動的に再紐付けする。
      return { parentAgencyId: null, pendingParentExternalId: parentExternalId };
    }
    if (existingId) {
      const cyclic = await wouldCreateCycle(existingId, parent.id, (id) => repo.findAgencyParentId(tx, id));
      if (cyclic) {
        throw new AgencyValidationError('Cannot set a descendant agency as parent_external_id.');
      }
    }
    return { parentAgencyId: parent.id, pendingParentExternalId: null };
  }

  if (!existingId && typeof loginEmail === 'string' && loginEmail.trim().length > 0) {
    // 仕様書外の拡張: 新規代理店作成時にparent_external_idの指定がなく、login_emailが
    // 「このサイトで購入経験があり、既に代理店へ永久帰属しているユーザー」のメールアドレスと
    // 一致する場合、その元の代理店(紹介者)を上位代理店として自動継承する。
    // (例: 評議員NFTを購入した会員がインフルエンサー申請を経て代理店に昇格するケース)
    const referredByAgencyId = await repo.findReferredByAgencyId(tx, loginEmail);
    if (referredByAgencyId) {
      return { parentAgencyId: referredByAgencyId, pendingParentExternalId: undefined };
    }
  }

  return { parentAgencyId: undefined, pendingParentExternalId: undefined };
}

// 代理店の作成・更新・親再紐付け・ログインアカウント作成/昇格を単一トランザクションで行う
// (指示書8.4)。これにより「代理店だけ作成されてログイン作成が失敗する」部分成功を防ぐ
// (ProvisionAgencyAccountUseCaseが競合を検知した場合はAgencyLoginConflictErrorを投げ、
// トランザクション全体がロールバックされる)。通知メールの送信予定もnotification_outbox_events
// へ同一トランザクションで記録するため(残課題指示書Stage3)、呼び出し元は
// triggerImmediateNotificationDispatch()でベストエフォート即時実行を試みるだけでよく、
// 失敗しても後続のDispatcher(cron)が再送する。
export async function upsertAgency(input: UpsertAgencyRequest): Promise<UpsertAgencyResult> {
  return prisma.$transaction(async (tx) => {
    const existing = await repo.findAgencyByExternalId(tx, input.externalId);

    const { parentAgencyId, pendingParentExternalId } = await resolveParentAssignment(tx, input, existing?.id ?? null);

    const agency = existing
      ? await repo.updateAgency(tx, existing.id, {
          name: input.name,
          parentAgencyId,
          pendingParentExternalId,
          defaultCommissionRate: input.defaultCommissionRate ?? undefined,
          contactName: input.contactName ?? undefined,
          contactEmail: input.contactEmail ?? undefined,
          status: input.status ?? undefined,
        })
      : await repo.createAgency(tx, {
          externalId: input.externalId,
          name: input.name,
          code: await generateAgencyCode(tx),
          parentAgencyId: parentAgencyId ?? null,
          pendingParentExternalId: pendingParentExternalId ?? null,
          defaultCommissionRate: input.defaultCommissionRate ?? 0,
          // contact_name未指定時はnameを使う(相手仕様書5章のフィールド説明に合わせる)。
          contactName: input.contactName ?? input.name,
          contactEmail: input.contactEmail ?? null,
          status: input.status ?? 'active',
        });

    await reconcilePendingParents(tx, input.externalId, agency.id);

    const provision = await provisionAgencyAccount(tx, agency.id, agency.contactName ?? agency.name, input.loginEmail);

    return {
      agency,
      created: !existing,
      loginProvisioned: provision.provisioned,
    };
  });
}
