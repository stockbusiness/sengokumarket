import type { AdminRole } from '@sengoku/contracts';
import type { NotificationOutboxEvent } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import {
  createPasswordResetTokenWithId,
  getOrCreateDeterministicPasswordResetToken,
  invalidatePasswordResetToken,
} from '../../../services/passwordReset';
import { getBankTransferConfig, BANK_TRANSFER_EXPIRY_DAYS } from '../../../services/bankTransfer';
import { sendNotificationOrThrow } from './sendNotification.usecase';
import {
  ADMIN_ROLE_LABEL,
  buildAdminAccountSetupEmail,
  buildAgencyAccessGrantedEmail,
  buildAgencyAccountSetupEmail,
  buildGuestPasswordSetupEmail,
} from '../templates/passwordSetup';
import { buildWalletClaimReissuedEmail } from '../templates/walletClaimReissued';
import { buildPurchaseCompleteEmail } from '../templates/purchaseComplete';
import { buildBankTransferInstructionsEmail } from '../templates/bankTransfer';
import { buildPasswordResetEmail } from '../templates/passwordReset';
import { buildCartAbandonedEmail } from '../templates/cartAbandoned';
import { buildWalletReminderEmail } from '../templates/walletReminder';
import { reissueWalletClaimToken } from '../../../services/walletClaim';
import { getWalletClaimWebBaseUrl } from '../../../services/walletClaimConfig';
import * as repo from '../infrastructure/notificationOutbox.repository';
import type {
  AdminAccountSetupPayload,
  AgencyAccessGrantedPayload,
  AgencyAccountSetupPayload,
  BankTransferInstructionsPayload,
  CartAbandonedPayload,
  GuestPasswordSetupPayload,
  PasswordResetPayload,
  PurchaseCompletePayload,
  WalletClaimReissuedPayload,
  WalletReminderPayload,
} from '../domain/notificationOutbox.types';

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

// 最終安定化指示書Phase2: 同一Notification Outbox Event(event.id)のretryは同じTokenを
// 再利用する(決定論的発行、NOTIFICATION_TOKEN_DERIVATION_SECRET設定時のみ)。未設定の間は
// 既存の都度ランダム発行(invalidate→新規create)にフォールバックする。
async function getOrCreatePasswordResetTokenForEvent(
  event: NotificationOutboxEvent,
  userId: string,
  purpose: string,
): Promise<{ token: string; tokenId: string }> {
  const deterministic = await getOrCreateDeterministicPasswordResetToken(userId, {
    eventId: event.id,
    subjectId: userId,
    tokenVersion: 0,
    purpose,
  });
  if (deterministic) return deterministic;

  if (event.passwordResetTokenId) {
    await invalidatePasswordResetToken(event.passwordResetTokenId);
  }
  return createPasswordResetTokenWithId(userId);
}

async function buildAndSend(event: NotificationOutboxEvent): Promise<void> {
  if (event.eventType === 'agency_account_setup') {
    const payload = event.payload as unknown as AgencyAccountSetupPayload;
    const { token, tokenId } = await getOrCreatePasswordResetTokenForEvent(event, payload.userId, 'agency_account_setup');
    await repo.recordPasswordResetTokenId(prisma, event.id, tokenId);
    await sendNotificationOrThrow(buildAgencyAccountSetupEmail(event.recipient, payload.name, token));
    return;
  }
  if (event.eventType === 'agency_access_granted') {
    const payload = event.payload as unknown as AgencyAccessGrantedPayload;
    await sendNotificationOrThrow(buildAgencyAccessGrantedEmail(event.recipient, payload.name));
    return;
  }
  if (event.eventType === 'wallet_claim_reissued') {
    // Wallet Claim本番前安定化指示書(2026-07-25)Phase1・Phase11: 新Tokenの発行自体を
    // Dispatcher実行時に行う(agency_account_setupのpassword reset tokenと同じ設計。
    // 生Token・生URLをpayloadへ保存しない)。
    const payload = event.payload as unknown as WalletClaimReissuedPayload;
    const order = await prisma.order.findUnique({ where: { id: payload.orderId } });
    if (!order) throw new Error('order not found for wallet_claim_reissued notification');

    const base = await getWalletClaimWebBaseUrl();
    if (!base) throw new Error('wallet_claim_web_base_url is not configured');

    const token = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, payload.orderId, event.id));
    if (!token) throw new Error('wallet claim is not reissuable in its current status');

    await sendNotificationOrThrow(buildWalletClaimReissuedEmail(event.recipient, order.customerName, `${base}/claim/${token}`));
    return;
  }
  if (event.eventType === 'purchase_complete') {
    // Wallet Claim本番前安定化指示書(2026-07-25)Phase11(13.3「Tokenを含む通知」): 受取Claim
    // URLの生Tokenはpayloadへ保存せず、wallet_claim_reissuedと同じくDispatcher実行時に発行する
    // (対象注文にWalletClaimが無い・既にCLAIMED以降で再発行不可の場合はnullが返り、その場合は
    // Claimリンクを含めないメールとして送信する)。
    const payload = event.payload as unknown as PurchaseCompletePayload;
    const order = await prisma.order.findUnique({ where: { id: payload.orderId } });
    if (!order) throw new Error('order not found for purchase_complete notification');
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    const walletClaimToken = await prisma.$transaction((tx) => reissueWalletClaimToken(tx, order.id, event.id));
    await sendNotificationOrThrow(await buildPurchaseCompleteEmail(order, items, walletClaimToken));
    return;
  }
  if (event.eventType === 'guest_password_setup') {
    const payload = event.payload as unknown as GuestPasswordSetupPayload;
    const { token, tokenId } = await getOrCreatePasswordResetTokenForEvent(event, payload.userId, 'guest_password_setup');
    await repo.recordPasswordResetTokenId(prisma, event.id, tokenId);
    await sendNotificationOrThrow(buildGuestPasswordSetupEmail(event.recipient, payload.name, token));
    return;
  }
  if (event.eventType === 'bank_transfer_instructions') {
    const payload = event.payload as unknown as BankTransferInstructionsPayload;
    const order = await prisma.order.findUnique({ where: { id: payload.orderId } });
    if (!order) throw new Error('order not found for bank_transfer_instructions notification');
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    const config = await getBankTransferConfig();
    await sendNotificationOrThrow(buildBankTransferInstructionsEmail(order, items, config.info, BANK_TRANSFER_EXPIRY_DAYS));
    return;
  }
  if (event.eventType === 'password_reset') {
    const payload = event.payload as unknown as PasswordResetPayload;
    const { token, tokenId } = await getOrCreatePasswordResetTokenForEvent(event, payload.userId, 'password_reset');
    await repo.recordPasswordResetTokenId(prisma, event.id, tokenId);
    await sendNotificationOrThrow(buildPasswordResetEmail(event.recipient, payload.name, token));
    return;
  }
  if (event.eventType === 'cart_abandoned') {
    const payload = event.payload as unknown as CartAbandonedPayload;
    const order = await prisma.order.findUnique({ where: { id: payload.orderId } });
    if (!order) throw new Error('order not found for cart_abandoned notification');
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id }, include: { product: true } });
    await sendNotificationOrThrow(buildCartAbandonedEmail(order, items, items[0]?.product.slug ?? null));
    return;
  }
  if (event.eventType === 'admin_account_setup') {
    const payload = event.payload as unknown as AdminAccountSetupPayload;
    const { token, tokenId } = await getOrCreatePasswordResetTokenForEvent(event, payload.userId, 'admin_account_setup');
    await repo.recordPasswordResetTokenId(prisma, event.id, tokenId);
    const roleLabel = ADMIN_ROLE_LABEL[payload.role as AdminRole] ?? payload.role;
    await sendNotificationOrThrow(buildAdminAccountSetupEmail(event.recipient, payload.name, token, roleLabel));
    return;
  }
  if (event.eventType === 'wallet_reminder') {
    const payload = event.payload as unknown as WalletReminderPayload;
    const nftIssue = await prisma.nftIssue.findUnique({ where: { id: payload.nftIssueId }, include: { order: true } });
    if (!nftIssue) throw new Error('nft issue not found for wallet_reminder notification');
    await sendNotificationOrThrow(
      buildWalletReminderEmail(event.recipient, nftIssue.order.customerName, nftIssue.order.orderNumber),
    );
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
