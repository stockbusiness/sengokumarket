import type { Prisma } from '@prisma/client';
import * as repo from '../infrastructure/prismaAgency.repository';
import { enqueueNotification } from '../../notifications/infrastructure/notificationOutbox.repository';
import { AgencyLoginConflictError } from '../domain/agency.types';

type Tx = Prisma.TransactionClient;

// 既に代理店ポータル・管理者として使われているアカウントは横取りしない。
const TAKEN_ROLES = new Set(['agency', 'admin', 'admin_viewer']);

export interface ProvisionResult {
  provisioned: boolean;
}

// ログインアカウントの作成・昇格。通知(パスワード設定案内・アクセス許可通知)は
// notification_outbox_eventsへ同一トランザクションで記録するのみとし(残課題指示書Stage3)、
// 実際のメール送信・トークン発行はcommit後にDispatcherが行う。これにより、代理店・ユーザー
// 作成に成功したのに通知だけ失われて再送できない、という問題を防ぐ。
export async function provisionAgencyAccount(
  tx: Tx,
  agencyId: string,
  agencyName: string,
  loginEmail: string | null | undefined,
): Promise<ProvisionResult> {
  if (!loginEmail || loginEmail.trim().length === 0) {
    return { provisioned: false };
  }

  const alreadyHasLogin = await repo.findLoginUserForAgency(tx, agencyId);
  if (alreadyHasLogin) {
    return { provisioned: false };
  }

  const existingUserByEmail = await repo.findUserByEmailInsensitive(tx, loginEmail);

  if (existingUserByEmail) {
    if (TAKEN_ROLES.has(existingUserByEmail.role)) {
      // ここで例外を投げてトランザクション全体をロールバックすることで、
      // 「代理店だけ作成されてログイン作成に失敗する」部分成功を防ぐ。
      throw new AgencyLoginConflictError('login_email is already used by another admin/agency account.');
    }

    // 仕様書外の拡張: 既存の一般会員アカウント(評議員NFT購入者等)を代理店ポータルログインに
    // 昇格させる。既にパスワードを持っているため、仮パスワードの再発行・設定メールは不要。
    await repo.promoteUserToAgency(tx, existingUserByEmail.id, agencyId);
    await enqueueNotification(tx, {
      eventType: 'agency_access_granted',
      recipient: existingUserByEmail.email,
      payload: { name: existingUserByEmail.name },
    });
    return { provisioned: true };
  }

  const user = await repo.createAgencyLoginUser(tx, { name: agencyName, email: loginEmail, agencyId });
  await enqueueNotification(tx, {
    eventType: 'agency_account_setup',
    recipient: user.email,
    payload: { name: user.name, userId: user.id },
  });
  return { provisioned: true };
}
