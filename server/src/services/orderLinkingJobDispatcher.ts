import crypto from 'crypto';
import type { OrderLinkingJob } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { isSennokuniIntegrationEnabled } from './sennokuniIntegrationConfig';
import { resolveCommonUserId } from './externalCommonUserClient';
import { captureReferralToken } from './externalReferralClient';

// 仕様書外の拡張(残課題指示書Stage4): order_linking_jobsの実送信ディスパッチャ。
// integration_outbox_eventsのdispatcher(integrationOutboxDispatcher.ts)と同じ「条件付きUPDATEに
// よるアトミックなclaim + 指数バックオフ + 最大試行超過でdead」設計を踏襲する。
// SENNOKUNI_INTEGRATION_ENABLED(既定OFF)が有効化されるまで、呼び出してもpending件数を数えるだけで
// 実送信は一切発生しない("Feature Flagでdormantなコード"という方針)。Flag無効の間はジョブを
// claimせずpendingのまま残すため、再度有効化した時点で溜まったジョブが処理される。

const BATCH_LIMIT = 50;
const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [5, 10, 20, 40, 60];
const STALE_PROCESSING_MS = 10 * 60 * 1000;

export interface DispatchOrderLinkingJobsResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  dead: number;
  skipped: number;
}

function generateProcessingToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

export async function processOrderLinkingJobs(): Promise<DispatchOrderLinkingJobsResult> {
  const result: DispatchOrderLinkingJobsResult = { claimed: 0, succeeded: 0, retrying: 0, dead: 0, skipped: 0 };

  if (!isSennokuniIntegrationEnabled()) return result;

  await prisma.orderLinkingJob.updateMany({
    where: { status: 'processing', processingStartedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
    data: { status: 'pending', processingToken: null, processingStartedAt: null },
  });

  const pendingJobs = await prisma.orderLinkingJob.findMany({
    where: { status: 'pending', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
    orderBy: { createdAt: 'asc' },
    take: BATCH_LIMIT,
  });

  for (const job of pendingJobs) {
    const processingToken = generateProcessingToken();
    const claim = await prisma.orderLinkingJob.updateMany({
      where: { id: job.id, status: 'pending' },
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

async function processAndRecordResult(job: OrderLinkingJob, result: DispatchOrderLinkingJobsResult): Promise<void> {
  const processingToken = job.processingToken!;
  try {
    await runJob(job);
    await prisma.orderLinkingJob.updateMany({
      where: { id: job.id, status: 'processing', processingToken },
      data: { status: 'succeeded', processedAt: new Date(), lastError: null },
    });
    result.succeeded++;
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    const attemptCount = job.attemptCount + 1;
    if (attemptCount >= MAX_ATTEMPTS) {
      await prisma.orderLinkingJob.updateMany({
        where: { id: job.id, status: 'processing', processingToken },
        data: { status: 'dead', attemptCount, lastError: message },
      });
      result.dead++;
    } else {
      const backoffMinutes = BACKOFF_MINUTES[Math.min(attemptCount - 1, BACKOFF_MINUTES.length - 1)];
      await prisma.orderLinkingJob.updateMany({
        where: { id: job.id, status: 'processing', processingToken },
        data: { status: 'pending', attemptCount, lastError: message, nextAttemptAt: new Date(Date.now() + backoffMinutes * 60 * 1000) },
      });
      result.retrying++;
    }
  }
}

async function runJob(job: OrderLinkingJob): Promise<void> {
  if (job.jobType === 'common_user_resolve') return runCommonUserResolveJob(job);
  if (job.jobType === 'referral_capture') return runReferralCaptureJob(job);
  throw new Error(`unknown order linking job type: ${job.jobType}`);
}

async function runCommonUserResolveJob(job: OrderLinkingJob): Promise<void> {
  if (!job.userId) throw new Error('common_user_resolve job is missing userId');

  const user = await prisma.user.findUnique({ where: { id: job.userId } });
  if (!user) return;

  let commonUserId = user.commonUserId;
  if (!commonUserId) {
    const resolved = await resolveCommonUserId({ externalUserId: user.id, verifiedEmail: user.email });
    if (!resolved) throw new Error('common_user_id resolve failed or returned no result');
    commonUserId = resolved.commonUserId;
    await prisma.user.update({ where: { id: user.id }, data: { commonUserId } });
  }

  if (job.orderId) {
    await prisma.order.update({
      where: { id: job.orderId },
      data: { commonUserId, commonUserResolutionStatus: 'resolved' },
    });
  }
}

async function runReferralCaptureJob(job: OrderLinkingJob): Promise<void> {
  if (!job.orderId) throw new Error('referral_capture job is missing orderId');

  const order = await prisma.order.findUnique({ where: { id: job.orderId } });
  if (!order) return;
  if (!order.referralCode) return;

  const captured = await captureReferralToken(order.referralCode);
  if (!captured) throw new Error('referral capture failed or returned no result');

  await prisma.order.update({ where: { id: order.id }, data: { referralSessionKey: captured.referralSessionKey } });
}

// Vercelには永続ワーカーが無いため、注文作成・会員登録のcommit直後にベストエフォートで即時実行し
// (NFT自動発行のtriggerImmediateNftMintProcessingと同じ考え方)、cron
// (process-order-linking-jobs)を取りこぼし・失敗時のセーフティネットとして併用する。
// ジョブ自体は既にDB(order_linking_jobs)へ永続化済みのため、ここで例外が起きても
// 呼び出し元(checkout・会員登録)の処理は失敗させない。
export async function triggerImmediateOrderLinkingDispatch(): Promise<void> {
  try {
    await processOrderLinkingJobs();
  } catch (e) {
    console.error('immediate order linking dispatch failed', { error: e });
  }
}
