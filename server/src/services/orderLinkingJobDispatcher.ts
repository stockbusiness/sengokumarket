import crypto from 'crypto';
import type { OrderLinkingJob } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { isSennokuniIntegrationEnabled } from './sennokuniIntegrationConfig';
import { resolveCommonUserId } from './externalCommonUserClient';
import { captureReferralToken, confirmReferral } from './externalReferralClient';

// 仕様書外の拡張(残課題指示書Stage4): order_linking_jobsの実送信ディスパッチャ。
// integration_outbox_eventsのdispatcher(integrationOutboxDispatcher.ts)と同じ「条件付きUPDATEに
// よるアトミックなclaim + 指数バックオフ + 最大試行超過でdead」設計を踏襲する。
// SENNOKUNI_INTEGRATION_ENABLED(既定OFF)が有効化されるまで、呼び出してもpending件数を数えるだけで
// 実送信は一切発生しない("Feature Flagでdormantなコード"という方針)。Flag無効の間はジョブを
// claimせずpendingのまま残すため、再度有効化した時点で溜まったジョブが処理される。

// 本番安定化指示書Stage5(8.5・方針A): Feature Flag無効中に溜まったbacklogを有効化後に
// 一括暴走させないための調整弁。既定値は変更前と同じ50件/回のままだが、backlogが大きい状態で
// 有効化する際は運用側でこの値を一時的に下げられる(定期実行(5分間隔)と合わせて、実質的な
// 宛先への送信レートもこの値で調整できる)。
function getBatchLimit(): number {
  const raw = process.env.ORDER_LINKING_BATCH_LIMIT;
  if (raw === undefined) return 50;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 50;
}

const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [5, 10, 20, 40, 60];
const STALE_PROCESSING_MS = 10 * 60 * 1000;

// 本番安定化指示書Stage5(8.4): depends_on_job_idのような依存グラフを追加する代わりに、
// job_type優先順位でDispatcherが処理する(指示書8.4の代替案)。同一バッチ内でcommon_user_resolve→
// referral_capture→referral_confirm_purchaseの順に処理することで、依存先が同じバッチ内で
// 先に解決されている可能性を高める。
const JOB_TYPE_PRIORITY = ['common_user_resolve', 'referral_capture', 'referral_confirm_purchase'] as const;

// 本番安定化指示書Stage5(8.3): 依存先(common_user_id解決・referral capture)がまだ完了して
// いないだけの状態。通常の失敗(外部APIエラー等)とは区別し、attempt_countを増やさず
// blockedへ遷移させることで、依存待ちだけで最大試行回数を消費してdeadになるのを防ぐ。
// 本番安定化指示書Stage9(12.2): common_user_id_conflict(代理店HUBから既存記録と異なる
// common_user_idが返った場合)も同じblocked機構で「停止・管理者確認」を表現する。ただし
// これは時間経過で自然に解決する依存待ちではなく、管理者による明示的な確認・修正が必要な
// ため、fetchClaimableJobsByPriorityの自動再評価対象からは除外する(無限に外部APIを
// 叩き直さないようにするため)。
class OrderLinkingDependencyNotReadyError extends Error {
  constructor(
    public readonly reason: 'common_user_unresolved' | 'referral_session_unresolved' | 'common_user_id_conflict',
    detail?: string,
  ) {
    super(detail ?? `order linking job dependency not ready: ${reason}`);
  }
}

// 本番安定化指示書Stage2(5.4「1回の処理時間上限」): integration_outbox_eventsの
// getTimeBudgetMsと同じ方針(環境変数で調整可能・"0"も有効な設定値として扱うためisFiniteで
// 判定・既定値は保守的に8000ms)。
function getTimeBudgetMs(): number {
  const raw = process.env.ORDER_LINKING_TIME_BUDGET_MS;
  if (raw === undefined) return 8000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 8000;
}

export interface DispatchOrderLinkingJobsResult {
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

// 本番安定化指示書Stage5(8.6「backlog件数表示」)。管理API(GET /api/admin/order-linking-jobs/backlog)
// から呼ぶ。pending・blockedの件数を合算した「未処理」件数を返す。
export async function countOrderLinkingJobsBacklog(): Promise<{ pending: number; blocked: number; total: number }> {
  const [pending, blocked] = await Promise.all([
    prisma.orderLinkingJob.count({ where: { status: 'pending' } }),
    prisma.orderLinkingJob.count({ where: { status: 'blocked' } }),
  ]);
  return { pending, blocked, total: pending + blocked };
}

async function fetchClaimableJobsByPriority(limit: number): Promise<OrderLinkingJob[]> {
  const jobs: OrderLinkingJob[] = [];
  for (const jobType of JOB_TYPE_PRIORITY) {
    if (jobs.length >= limit) break;
    const batch = await prisma.orderLinkingJob.findMany({
      where: {
        jobType,
        status: { in: ['pending', 'blocked'] },
        // 本番安定化指示書Stage9(12.2): common_user_id_conflictは時間経過で自然に解決しない
        // (管理者による確認・修正が必要)ため、自動再評価から除外する。管理者による明示的な
        // 再送(retryOrderLinkingJob)でのみ再評価する。
        NOT: { status: 'blocked', blockedReason: 'common_user_id_conflict' },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit - jobs.length,
    });
    jobs.push(...batch);
  }
  return jobs;
}

export async function processOrderLinkingJobs(): Promise<DispatchOrderLinkingJobsResult> {
  const result: DispatchOrderLinkingJobsResult = { claimed: 0, succeeded: 0, retrying: 0, blocked: 0, dead: 0, skipped: 0 };

  if (!isSennokuniIntegrationEnabled()) return result;

  const startedAt = Date.now();
  const timeBudgetMs = getTimeBudgetMs();
  const batchLimit = getBatchLimit();

  await prisma.orderLinkingJob.updateMany({
    where: { status: 'processing', processingStartedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
    data: { status: 'pending', processingToken: null, processingStartedAt: null },
  });

  const claimableJobs = await fetchClaimableJobsByPriority(batchLimit);

  for (const job of claimableJobs) {
    if (Date.now() - startedAt >= timeBudgetMs) {
      // Functionの残り時間に余裕がないため、これ以上は新規claimしない
      // (claim済みでない行はpending/blockedのまま残り、次回の呼び出しで再評価される)。
      break;
    }

    const processingToken = generateProcessingToken();
    const claim = await prisma.orderLinkingJob.updateMany({
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

async function processAndRecordResult(job: OrderLinkingJob, result: DispatchOrderLinkingJobsResult): Promise<void> {
  const processingToken = job.processingToken!;
  try {
    await runJob(job);
    await prisma.orderLinkingJob.updateMany({
      where: { id: job.id, status: 'processing', processingToken },
      data: { status: 'succeeded', processedAt: new Date(), lastError: null, blockedReason: null },
    });
    result.succeeded++;
  } catch (e) {
    if (e instanceof OrderLinkingDependencyNotReadyError) {
      // attempt_countは増やさない(依存待ちだけで最大試行回数を消費させない)。
      // 本番安定化指示書Stage9(12.4「conflict管理可能」): lastErrorへ具体的な理由
      // (common_user_id_conflictの場合は既存値・新しい解決値)も記録し、管理画面
      // (GET /api/admin/order-linking-jobs)で内容を確認できるようにする。
      await prisma.orderLinkingJob.updateMany({
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
  if (job.jobType === 'referral_confirm_purchase') return runReferralConfirmPurchaseJob(job);
  throw new Error(`unknown order linking job type: ${job.jobType}`);
}

const EXTERNAL_IDENTITY_SYSTEM_KEY = 'sengoku-market';

async function runCommonUserResolveJob(job: OrderLinkingJob): Promise<void> {
  if (!job.userId) throw new Error('common_user_resolve job is missing userId');

  const user = await prisma.user.findUnique({ where: { id: job.userId } });
  if (!user) return;

  let commonUserId = user.commonUserId;
  if (!commonUserId) {
    const resolved = await resolveCommonUserId({
      externalUserId: user.id,
      name: user.name,
      email: user.email,
      emailVerified: false,
      phone: user.phone,
    });
    if (!resolved) throw new Error('common_user_id resolve failed or returned no result');

    // 本番安定化指示書Stage9(12.2「common user merge」): 既にexternal_identitiesへ記録済みの
    // common_user_idと異なる値が代理店HUBから返った場合、単純上書きしない。conflictとして
    // 停止し、管理者確認を必要とする(自動再評価はしない。fetchClaimableJobsByPriority参照)。
    const existingIdentity = await prisma.externalIdentity.findUnique({
      where: { systemKey_externalUserId: { systemKey: EXTERNAL_IDENTITY_SYSTEM_KEY, externalUserId: user.id } },
    });
    if (existingIdentity?.commonUserId && existingIdentity.commonUserId !== resolved.commonUserId) {
      throw new OrderLinkingDependencyNotReadyError(
        'common_user_id_conflict',
        `existing external_identities.common_user_id=${existingIdentity.commonUserId} but hub returned=${resolved.commonUserId}`,
      );
    }

    // 本番安定化指示書Stage9(12.1「ExternalIdentity」): common_user_id解決成功時、
    // users.common_user_idだけでなくexternal_identitiesへも保存し、同一ユーザーの複数
    // identity(将来他システム分含む)を追跡可能にする。
    await prisma.externalIdentity.upsert({
      where: { systemKey_externalUserId: { systemKey: EXTERNAL_IDENTITY_SYSTEM_KEY, externalUserId: user.id } },
      create: {
        userId: user.id,
        systemKey: EXTERNAL_IDENTITY_SYSTEM_KEY,
        externalUserId: user.id,
        commonUserId: resolved.commonUserId,
        identityType: 'email',
        verifiedAt: new Date(),
      },
      update: { commonUserId: resolved.commonUserId, verifiedAt: new Date() },
    });

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

  const captured = await captureReferralToken(order.id, order.referralCode);
  if (!captured) throw new Error('referral capture failed or returned no result');

  await prisma.order.update({ where: { id: order.id }, data: { referralSessionKey: captured.referralSessionKey } });
}

// 残課題指示書Stage5: 決済確定(applyPaidOrderSideEffects)と同一トランザクションでenqueueされる。
// referral_capture・common_user_resolveジョブとの処理順序保証はないため、このジョブが先に
// claimされた場合はreferralSessionKey/commonUserIdがまだ解決されていないことがある。その場合は
// 本番安定化指示書Stage5(8.3)のDependencyNotReadyErrorを投げてblocked状態にする
// (attempt_countを消費せず、他の2ジョブが解決を終えた後の再試行で成功する)。
async function runReferralConfirmPurchaseJob(job: OrderLinkingJob): Promise<void> {
  if (!job.orderId) throw new Error('referral_confirm_purchase job is missing orderId');

  const order = await prisma.order.findUnique({ where: { id: job.orderId } });
  if (!order) return;
  if (!order.referralCode) return;
  if (!order.referralSessionKey) throw new OrderLinkingDependencyNotReadyError('referral_session_unresolved');
  if (!order.commonUserId) throw new OrderLinkingDependencyNotReadyError('common_user_unresolved');

  const confirmed = await confirmReferral({
    orderId: order.id,
    referralSessionKey: order.referralSessionKey,
    commonUserId: order.commonUserId,
    event: 'purchase',
  });
  if (!confirmed) throw new Error('referral confirm failed or returned no result');

  // 本番安定化指示書Stage9(12.3「confirm結果検証」): confirmレスポンスのcommon_user_idが
  // 送信値と一致するか検証する。一致しない場合は成功扱いにしない(代理店4役を誤ったユーザーへ
  // 紐付けてしまう事故を防ぐ)。通常のエラーとして扱い、既存のbackoff/再試行に委ねる。
  if (confirmed.commonUserId !== order.commonUserId) {
    throw new Error(
      `referral confirm response common_user_id mismatch: sent=${order.commonUserId}, returned=${confirmed.commonUserId}`,
    );
  }

  await prisma.order.update({
    where: { id: order.id },
    data: {
      registrationReferrerAgentCode: confirmed.registrationReferrerAgencyId ?? undefined,
      assignedAgentCode: confirmed.assignedAgencyId ?? undefined,
      salesAgentCode: confirmed.salesAgentId ?? undefined,
      closingAgentCode: confirmed.closingAgentId ?? undefined,
    },
  });
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

// 本番安定化指示書Stage5(8.6「手動再送」)。integrationOutboxDispatcher.retryOutboxEventと
// 同じ設計(processing/succeeded以外から手動claim→即時実行)。Feature Flag無効時は手動操作でも
// 実送信しない。
export async function retryOrderLinkingJob(id: string): Promise<{ ok: boolean; status?: string }> {
  if (!isSennokuniIntegrationEnabled()) return { ok: false };

  const existing = await prisma.orderLinkingJob.findUnique({ where: { id } });
  if (!existing || existing.status === 'processing' || existing.status === 'succeeded') {
    return { ok: false };
  }

  const processingToken = generateProcessingToken();
  const claim = await prisma.orderLinkingJob.updateMany({
    where: { id, status: existing.status },
    data: { status: 'processing', processingToken, processingStartedAt: new Date() },
  });
  if (claim.count === 0) return { ok: false };

  const result: DispatchOrderLinkingJobsResult = { claimed: 1, succeeded: 0, retrying: 0, blocked: 0, dead: 0, skipped: 0 };
  await processAndRecordResult({ ...existing, status: 'processing', processingToken }, result);

  const refreshed = await prisma.orderLinkingJob.findUnique({ where: { id } });
  return { ok: true, status: refreshed?.status };
}

// 本番安定化指示書Stage5(8.6「skip」): 依存の解決が見込めない等の理由で管理者が処理対象から
// 外す操作。retry(実際に外部送信を試みる)とは異なり、実送信は一切行わずstatus='skipped'に
// するだけ(succeeded/failed/deadと偽らない専用の終端状態)。processing中のジョブは対象外
// (外部APIへ送信済みの可能性があるため)。
export async function skipOrderLinkingJob(id: string): Promise<{ ok: boolean }> {
  const existing = await prisma.orderLinkingJob.findUnique({ where: { id } });
  if (!existing || existing.status === 'processing' || existing.status === 'succeeded' || existing.status === 'skipped') {
    return { ok: false };
  }

  const claim = await prisma.orderLinkingJob.updateMany({
    where: { id, status: existing.status },
    data: { status: 'skipped', blockedReason: null, processingToken: null, processingStartedAt: null },
  });
  return { ok: claim.count > 0 };
}
