import crypto from 'crypto';
import type { Prisma, PurchaseProvisioningJob } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { appConfig } from '../shared/config/appConfig';
import { isPurchaseProvisioningEnabled } from './purchaseProvisioningConfig';
import { requestPurchaseProvisioning, revokePurchaseProvisioning } from './externalPurchaseProvisioningClient';

// 購入後代理店システム連携実装指示書 6.4章: order_linking_jobs/integration_outbox_eventsと
// 同じ「条件付きUPDATEによるアトミックなclaim + 指数バックオフ + 最大試行超過でdead」設計を
// 踏襲する(orderLinkingJobDispatcher.tsと定数・構造をそろえている)。

function getBatchLimit(): number {
  const raw = process.env.PURCHASE_PROVISIONING_BATCH_LIMIT;
  if (raw === undefined) return 50;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 50;
}

function getTimeBudgetMs(): number {
  const raw = process.env.PURCHASE_PROVISIONING_TIME_BUDGET_MS;
  if (raw === undefined) return 8000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 8000;
}

const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [5, 10, 20, 40, 60];
const STALE_PROCESSING_MS = 10 * 60 * 1000;

// order_linking_jobsのOrderLinkingDependencyNotReadyErrorと同じ考え方: common_user_resolve
// ジョブ(order_linking_jobs)の完了待ちであり、通常の失敗(外部APIエラー等)とは区別して
// attempt_countを消費しないままblockedにする。
class ProvisioningDependencyNotReadyError extends Error {
  constructor(detail?: string) {
    super(detail ?? 'purchase provisioning job dependency not ready: common_user_unresolved');
  }
  readonly reason = 'common_user_unresolved' as const;
}

export interface DispatchPurchaseProvisioningJobsResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  blocked: number;
  dead: number;
  skipped: number;
}

function generateProcessingToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

export async function countPurchaseProvisioningBacklog(): Promise<{ pending: number; blocked: number; total: number }> {
  const [pending, blocked] = await Promise.all([
    prisma.purchaseProvisioningJob.count({ where: { status: 'pending' } }),
    prisma.purchaseProvisioningJob.count({ where: { status: 'blocked' } }),
  ]);
  return { pending, blocked, total: pending + blocked };
}

async function fetchClaimableJobs(limit: number): Promise<PurchaseProvisioningJob[]> {
  return prisma.purchaseProvisioningJob.findMany({
    where: {
      status: { in: ['pending', 'blocked'] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
}

export async function processPurchaseProvisioningJobs(): Promise<DispatchPurchaseProvisioningJobsResult> {
  const result: DispatchPurchaseProvisioningJobsResult = { claimed: 0, succeeded: 0, retrying: 0, blocked: 0, dead: 0, skipped: 0 };

  if (!isPurchaseProvisioningEnabled()) return result;

  const startedAt = Date.now();
  const timeBudgetMs = getTimeBudgetMs();
  const batchLimit = getBatchLimit();

  await prisma.purchaseProvisioningJob.updateMany({
    where: { status: 'processing', processingStartedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
    data: { status: 'pending', processingToken: null, processingStartedAt: null },
  });

  const claimableJobs = await fetchClaimableJobs(batchLimit);

  for (const job of claimableJobs) {
    if (Date.now() - startedAt >= timeBudgetMs) break;

    const processingToken = generateProcessingToken();
    const claim = await prisma.purchaseProvisioningJob.updateMany({
      where: { id: job.id, status: { in: ['pending', 'blocked'] } },
      data: { status: 'processing', processingToken, processingStartedAt: new Date() },
    });
    if (claim.count === 0) {
      result.skipped++;
      continue;
    }
    result.claimed++;
    await processAndRecordResult({ ...job, status: 'processing', processingToken }, result);
  }

  return result;
}

async function processAndRecordResult(job: PurchaseProvisioningJob, result: DispatchPurchaseProvisioningJobsResult): Promise<void> {
  const processingToken = job.processingToken!;
  try {
    await runJob(job);
    await prisma.purchaseProvisioningJob.updateMany({
      where: { id: job.id, status: 'processing', processingToken },
      data: { status: 'succeeded', processedAt: new Date(), lastError: null, blockedReason: null },
    });
    result.succeeded++;
  } catch (e) {
    if (e instanceof ProvisioningDependencyNotReadyError) {
      await prisma.purchaseProvisioningJob.updateMany({
        where: { id: job.id, status: 'processing', processingToken },
        data: {
          status: 'blocked',
          blockedReason: e.reason,
          lastError: e.message.slice(0, 2000),
          processingToken: null,
          processingStartedAt: null,
        },
      });
      result.blocked++;
      return;
    }

    const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    const attemptCount = job.attemptCount + 1;
    if (attemptCount >= MAX_ATTEMPTS) {
      await prisma.purchaseProvisioningJob.updateMany({
        where: { id: job.id, status: 'processing', processingToken },
        data: { status: 'dead', attemptCount, lastError: message },
      });
      await markOrderProvisioningFailed(job, message);
      result.dead++;
    } else {
      const backoffMinutes = BACKOFF_MINUTES[Math.min(attemptCount - 1, BACKOFF_MINUTES.length - 1)];
      await prisma.purchaseProvisioningJob.updateMany({
        where: { id: job.id, status: 'processing', processingToken },
        data: { status: 'pending', attemptCount, lastError: message, nextAttemptAt: new Date(Date.now() + backoffMinutes * 60 * 1000) },
      });
      if (job.action === 'provision') await markOrderProvisioningFailed(job, message, 'pending');
      result.retrying++;
    }
  }
}

// 6.9章のorders.agency_provisioning_statusキャッシュへ最新の失敗理由を反映する。
// retry中(まだdeadでない)はstatusを'pending'のまま保持し、最終的にdeadへ至った場合のみ
// 'failed'にする(購入完了画面・マイページの表示が試行のたびに揺れ動かないようにする)。
async function markOrderProvisioningFailed(
  job: PurchaseProvisioningJob,
  message: string,
  statusOverride?: 'pending',
): Promise<void> {
  if (job.action !== 'provision') return;
  await prisma.order.update({
    where: { id: job.orderId },
    data: { agencyProvisioningStatus: statusOverride ?? 'failed', agencyProvisioningLastError: message },
  });
}

async function runJob(job: PurchaseProvisioningJob): Promise<void> {
  if (job.action === 'provision') return runProvisionJob(job);
  if (job.action === 'revoke') return runRevokeJob(job);
  throw new Error(`unknown purchase provisioning job action: ${job.action}`);
}

async function runProvisionJob(job: PurchaseProvisioningJob): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: job.orderId } });
  if (!order) return;
  // 決済確定前に打ち切られた(返金・キャンセル等で既にnot_applicable/revokedへ進んでいた)場合は
  // 送信しない(fail-close。6.13章「保護条件: 決済・在庫を巻き戻さない」と対で、逆方向の
  // 事故=返金済み注文へアカウントを新規発行してしまうことも防ぐ)。
  if (order.paymentStatus !== 'paid') return;
  if (!order.commonUserId) throw new ProvisioningDependencyNotReadyError();

  const orderItems = await prisma.orderItem.findMany({ where: { orderId: order.id } });
  const productIds = [...new Set(orderItems.map((item) => item.productId))];
  const products = await prisma.product.findMany({ where: { id: { in: productIds } } });
  const productById = new Map(products.map((p) => [p.id, p]));

  const relevantItems = orderItems.filter((item) => {
    const product = productById.get(item.productId);
    return product && product.agencyAccessMode !== 'none';
  });
  // enqueue後に商品設定がnoneへ変更された等でno-opになるケース。
  if (relevantItems.length === 0) {
    await prisma.order.update({ where: { id: order.id }, data: { agencyProvisioningStatus: 'not_applicable' } });
    return;
  }

  const result = await requestPurchaseProvisioning({
    eventId: `evt_ppj_${job.id}`,
    correlationId: order.correlationId ?? order.id,
    commonUserId: order.commonUserId,
    externalUserId: order.userId ?? order.id,
    user: {
      name: order.customerName,
      email: order.customerEmail,
      // ログイン会員(userId有り)はJWT認証済みメールとして扱う。ゲスト購入時点では
      // メール検証済みかどうかの情報を保持していないため、安全側(false)を送る。
      emailVerified: Boolean(order.userId),
      phone: order.customerPhone,
    },
    order: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      paymentStatus: order.paymentStatus,
      totalAmount: order.totalAmount,
      paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    },
    items: relevantItems.map((item) => {
      const product = productById.get(item.productId)!;
      return {
        orderItemId: item.id,
        productId: item.productId,
        productCode: product.agencyProductCode,
        productName: item.productName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        subtotal: item.subtotal,
        entitlementStatus: 'granted',
        agencyAccessMode: product.agencyAccessMode,
        agencyRole: product.agencyRole,
      };
    }),
    agencyAssignment: {
      registrationReferrerAgencyId: order.registrationReferrerAgentCode,
      assignedAgencyId: order.assignedAgentCode,
      salesAgentId: order.salesAgentCode,
      closingAgentId: order.closingAgentCode,
      referralSessionKey: order.referralSessionKey,
    },
    loginProvisioning: {
      requested: true,
      mode: 'sso',
      returnUrl: appConfig.appUrl ? `${appConfig.appUrl}/mypage` : null,
    },
  });

  if (!result) throw new Error('purchase provisioning request failed or returned no result');
  // 本番安定化指示書Stage9(12.3)のreferral confirm検証と同じ考え方: レスポンスの
  // common_user_idが送信値と一致しない場合は成功扱いにしない(誤ったユーザーへログイン権限を
  // 付与する事故を防ぐ)。
  if (result.commonUserId !== order.commonUserId) {
    throw new Error(
      `purchase provisioning response common_user_id mismatch: sent=${order.commonUserId}, returned=${result.commonUserId}`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.purchaseProvisioningJob.update({
      where: { id: job.id },
      data: { commonUserId: result.commonUserId, responseJson: result as unknown as Prisma.InputJsonValue },
    });
    await tx.order.update({
      where: { id: order.id },
      data: {
        agencyProvisioningStatus: 'provisioned',
        agencyAccountType: result.accountType,
        agencyAccountId: result.accountId,
        agencyLoginEmail: result.loginEmail,
        agencyLoginMode: result.accessMode,
        agencyLoginUrl: result.loginUrl,
        agencyLoginUrlExpiresAt: result.loginUrlExpiresAt ? new Date(result.loginUrlExpiresAt) : null,
        agencyProvisionedAt: new Date(),
        agencyProvisioningLastError: null,
      },
    });
  });
}

async function runRevokeJob(job: PurchaseProvisioningJob): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: job.orderId } });
  if (!order) return;
  // アカウントを識別するcommon_user_idが無ければ、そもそも代理店システム側に
  // 取り消すべき対象が存在しない(no-op)。
  if (!order.commonUserId) return;

  const ok = await revokePurchaseProvisioning({
    eventId: `evt_ppj_${job.id}`,
    orderId: order.id,
    commonUserId: order.commonUserId,
    reason: 'full_refund',
  });
  if (!ok) throw new Error('purchase provisioning revoke failed or returned no result');

  await prisma.order.update({ where: { id: order.id }, data: { agencyProvisioningStatus: 'revoked' } });
}

// Vercelには永続ワーカーが無いため、決済確定・全額返金のcommit直後にベストエフォートで
// 即時実行し(既存のtriggerImmediateOrderLinkingDispatch等と同じ考え方)、cron
// (process-purchase-provisioning-jobs)を取りこぼし・失敗時のセーフティネットとして併用する。
export async function triggerImmediatePurchaseProvisioningDispatch(): Promise<void> {
  try {
    await processPurchaseProvisioningJobs();
  } catch (e) {
    console.error('immediate purchase provisioning dispatch failed', { error: e });
  }
}

export async function retryPurchaseProvisioningJob(id: string): Promise<{ ok: boolean; status?: string }> {
  if (!isPurchaseProvisioningEnabled()) return { ok: false };

  const existing = await prisma.purchaseProvisioningJob.findUnique({ where: { id } });
  if (!existing || existing.status === 'processing' || existing.status === 'succeeded') {
    return { ok: false };
  }

  const processingToken = generateProcessingToken();
  const claim = await prisma.purchaseProvisioningJob.updateMany({
    where: { id, status: existing.status },
    data: { status: 'processing', processingToken, processingStartedAt: new Date() },
  });
  if (claim.count === 0) return { ok: false };

  const result: DispatchPurchaseProvisioningJobsResult = { claimed: 1, succeeded: 0, retrying: 0, blocked: 0, dead: 0, skipped: 0 };
  await processAndRecordResult({ ...existing, status: 'processing', processingToken }, result);

  const refreshed = await prisma.purchaseProvisioningJob.findUnique({ where: { id } });
  return { ok: true, status: refreshed?.status };
}

export async function skipPurchaseProvisioningJob(id: string): Promise<{ ok: boolean }> {
  const existing = await prisma.purchaseProvisioningJob.findUnique({ where: { id } });
  if (!existing || existing.status === 'processing' || existing.status === 'succeeded' || existing.status === 'skipped') {
    return { ok: false };
  }

  const claim = await prisma.purchaseProvisioningJob.updateMany({
    where: { id, status: existing.status },
    data: { status: 'skipped', blockedReason: null, processingToken: null, processingStartedAt: null },
  });
  return { ok: claim.count > 0 };
}
