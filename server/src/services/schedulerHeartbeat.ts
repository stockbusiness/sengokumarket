import { prisma } from '../lib/prisma';

// 最終安定化指示書Phase7「Scheduler主系/予備系整理」: Vercel CronとGitHub Actions Cronの
// 5分間隔の二重実行を整理する。ジョブごとに主系スケジューラーを1つ決め、Preflightが
// 「直近10分以内の主系成功」を確認できるようにjob_scheduler_heartbeatsへ記録する。
//
// process-integration-outbox・process-notification-outboxはVercel Cronが5分間隔で主系、
// GitHub Actions Cronは予備(20分間隔、dispatch-cron-fallback.yml)。
// process-nft-mints・process-order-linking-jobsはGitHub Actions Cronが5分間隔で主系
// (dispatch-cron.yml)、Vercel Cronの日次実行は取りこぼし時の安全網(予備)として維持する。
export const PRIMARY_SCHEDULER_BY_JOB: Record<string, string> = {
  'process-integration-outbox': 'vercel',
  'process-notification-outbox': 'vercel',
  'process-nft-mints': 'github-actions',
  'process-order-linking-jobs': 'github-actions',
  'process-purchase-provisioning-jobs': 'github-actions',
};

const HEARTBEAT_FRESHNESS_MS = 10 * 60 * 1000;

function readCount(result: unknown, ...keys: string[]): number | null {
  if (typeof result !== 'object' || result === null) return null;
  const record = result as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number') return value;
  }
  return null;
}

// cronルートハンドラをこの関数で包むことで、実行元(schedulerSource)・成否・件数を
// job_scheduler_heartbeatsへ記録する。実行結果・例外はそのまま呼び出し元へ伝播させる
// (heartbeat記録の失敗が本来のジョブ処理を妨げないよう、記録自体はbest-effortにする)。
export async function withSchedulerHeartbeat<T>(jobName: string, schedulerSource: string, fn: () => Promise<T>): Promise<T> {
  let heartbeatId: string | null = null;
  try {
    const created = await prisma.jobSchedulerHeartbeat.create({
      data: { jobName, schedulerSource, startedAt: new Date(), status: 'running' },
    });
    heartbeatId = created.id;
  } catch {
    // heartbeat記録自体の失敗でジョブ実行を止めない。
  }

  try {
    const result = await fn();
    if (heartbeatId) {
      await prisma.jobSchedulerHeartbeat
        .update({
          where: { id: heartbeatId },
          data: {
            finishedAt: new Date(),
            status: 'success',
            claimedCount: readCount(result, 'claimed'),
            succeededCount: readCount(result, 'succeeded', 'issued'),
            failedCount: readCount(result, 'dead', 'failed'),
          },
        })
        .catch(() => undefined);
    }
    return result;
  } catch (e) {
    if (heartbeatId) {
      await prisma.jobSchedulerHeartbeat
        .update({
          where: { id: heartbeatId },
          data: { finishedAt: new Date(), status: 'failed', error: e instanceof Error ? e.message : String(e) },
        })
        .catch(() => undefined);
    }
    throw e;
  }
}

export interface PrimarySchedulerHealth {
  jobName: string;
  expectedSource: string;
  ok: boolean;
  lastSuccessAt: Date | null;
}

// Wallet Claim Preflight(walletClaimPreflight.ts)から参照する。主系スケジューラーによる
// 直近10分以内の成功実績があるかを確認する。
export async function checkPrimarySchedulerHealth(jobName: string): Promise<PrimarySchedulerHealth> {
  const expectedSource = PRIMARY_SCHEDULER_BY_JOB[jobName] ?? 'unknown';
  const lastSuccess = await prisma.jobSchedulerHeartbeat.findFirst({
    where: { jobName, schedulerSource: expectedSource, status: 'success' },
    orderBy: { finishedAt: 'desc' },
  });
  const lastSuccessAt = lastSuccess?.finishedAt ?? null;
  const ok = Boolean(lastSuccessAt && Date.now() - lastSuccessAt.getTime() <= HEARTBEAT_FRESHNESS_MS);
  return { jobName, expectedSource, ok, lastSuccessAt };
}
