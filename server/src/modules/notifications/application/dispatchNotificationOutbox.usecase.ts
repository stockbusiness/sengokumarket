import type { NotificationOutboxEvent } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { createPasswordResetTokenWithId, invalidatePasswordResetToken } from '../../../services/passwordReset';
import { sendNotificationOrThrow } from './sendNotification.usecase';
import { buildAgencyAccessGrantedEmail, buildAgencyAccountSetupEmail } from '../templates/passwordSetup';
import * as repo from '../infrastructure/notificationOutbox.repository';
import type { AgencyAccessGrantedPayload, AgencyAccountSetupPayload } from '../domain/notificationOutbox.types';

const BATCH_LIMIT = 10;

// 本番安定化指示書Stage2(5.4「1回の処理時間上限」): integration_outbox_eventsの
// getTimeBudgetMsと同じ方針(環境変数で調整可能・"0"も有効な設定値として扱うためisFiniteで
// 判定・既定値は保守的に8000ms)。
function getTimeBudgetMs(): number {
  const raw = process.env.NOTIFICATION_OUTBOX_TIME_BUDGET_MS;
  if (raw === undefined) return 8000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 8000;
}

export interface DispatchNotificationOutboxResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  dead: number;
}

// 残課題指示書Stage3: 代理店作成等と同一トランザクションで記録されたnotification_outbox_events
// を処理する。setup系はここでパスワード設定トークンを発行する(生成済みトークンはpayloadへ
// 保存しない。前回の未使用トークンがあれば無効化してから新規発行し、無制限に有効トークンが
// 増えるのを防ぐ)。
export async function dispatchPendingNotifications(): Promise<DispatchNotificationOutboxResult> {
  const result: DispatchNotificationOutboxResult = { claimed: 0, succeeded: 0, retrying: 0, dead: 0 };
  const startedAt = Date.now();
  const timeBudgetMs = getTimeBudgetMs();

  await repo.reclaimStaleProcessing(prisma);

  if (Date.now() - startedAt >= timeBudgetMs) {
    // Functionの残り時間に余裕がないため、新規claimを行わずpendingのまま残す
    // (次回の呼び出しで再評価される)。
    return result;
  }

  const claimedEvents = await repo.claimBatch(prisma, BATCH_LIMIT);
  result.claimed = claimedEvents.length;

  for (const event of claimedEvents) {
    if (Date.now() - startedAt >= timeBudgetMs) {
      // Functionの残り時間に余裕がないため、以降は処理を打ち切る(既にclaimBatchでprocessingへ
      // 遷移済みの残りの行は、次回呼び出し時にreclaimStaleProcessingで拾われる)。
      break;
    }
    await processEvent(event, result);
  }

  return result;
}

async function buildAndSend(event: NotificationOutboxEvent): Promise<void> {
  if (event.eventType === 'agency_account_setup') {
    const payload = event.payload as unknown as AgencyAccountSetupPayload;
    if (event.passwordResetTokenId) {
      await invalidatePasswordResetToken(event.passwordResetTokenId);
    }
    const { token, tokenId } = await createPasswordResetTokenWithId(payload.userId);
    await repo.recordPasswordResetTokenId(prisma, event.id, tokenId);
    await sendNotificationOrThrow(buildAgencyAccountSetupEmail(event.recipient, payload.name, token));
    return;
  }
  if (event.eventType === 'agency_access_granted') {
    const payload = event.payload as unknown as AgencyAccessGrantedPayload;
    await sendNotificationOrThrow(buildAgencyAccessGrantedEmail(event.recipient, payload.name));
    return;
  }
  throw new Error(`unknown notification eventType: ${event.eventType}`);
}

async function processEvent(event: NotificationOutboxEvent, result: DispatchNotificationOutboxResult): Promise<void> {
  const processingToken = event.processingToken!;
  try {
    await buildAndSend(event);
    await repo.markSucceeded(prisma, event.id, processingToken);
    result.succeeded++;
  } catch (e) {
    await repo.markFailed(prisma, event, processingToken, e);
    const refreshed = await repo.findById(prisma, event.id);
    if (refreshed?.status === 'dead') {
      result.dead++;
    } else {
      result.retrying++;
    }
  }
}

// Vercelには永続ワーカーが無いため、通知予定作成の直後にベストエフォートで即時実行し
// (NFT自動発行のtriggerImmediateNftMintProcessingと同じ考え方)、cron
// (process-notification-outbox)を取りこぼし・失敗時のセーフティネットとして併用する。
// 通知自体は既にDB(notification_outbox_events)へ永続化済みのため、ここで例外が起きても
// 呼び出し元(代理店連携API等)の処理は失敗させない。
export async function triggerImmediateNotificationDispatch(): Promise<void> {
  try {
    await dispatchPendingNotifications();
  } catch (e) {
    console.error('immediate notification dispatch failed', { error: e });
  }
}

// 管理画面からの手動再送用(agencyIntegration・admin両方から呼べる汎用エントリ)。
export async function retryNotification(id: string): Promise<{ ok: boolean; status?: string }> {
  const claimed = await repo.claimForManualRetry(prisma, id);
  if (!claimed) return { ok: false };

  const result: DispatchNotificationOutboxResult = { claimed: 0, succeeded: 0, retrying: 0, dead: 0 };
  await processEvent(claimed.event, result);
  const refreshed = await repo.findById(prisma, id);
  return { ok: true, status: refreshed?.status };
}
