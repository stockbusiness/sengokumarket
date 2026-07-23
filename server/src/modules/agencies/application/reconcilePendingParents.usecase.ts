import type { Prisma } from '@prisma/client';
import * as repo from '../infrastructure/prismaAgency.repository';

type Tx = Prisma.TransactionClient;

// 仕様書外の拡張(先方仕様書v3.6.40): このexternal_idを親として待っていた代理店
// (parent_external_idが未登録のまま保存されていた子)を、親レコードのupsertと同一
// トランザクション内で再紐付けする。
export function reconcilePendingParents(tx: Tx, resolvedExternalId: string, resolvedAgencyId: string): Promise<void> {
  return repo.reconcilePendingParents(tx, resolvedExternalId, resolvedAgencyId);
}
