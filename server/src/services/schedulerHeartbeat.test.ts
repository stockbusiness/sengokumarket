import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma';
import { checkPrimarySchedulerHealth, withSchedulerHeartbeat } from './schedulerHeartbeat';

const TEST_JOB_NAME = 'process-integration-outbox';

// 最終安定化指示書Phase7「Scheduler主系/予備系整理」。
describe('schedulerHeartbeat', () => {
  afterEach(async () => {
    await prisma.jobSchedulerHeartbeat.deleteMany({ where: { jobName: { in: [TEST_JOB_NAME, 'unit-test-job'] } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('withSchedulerHeartbeat', () => {
    it('成功時にstatus=success・claimed/succeeded/failedCountを記録する', async () => {
      const result = await withSchedulerHeartbeat('unit-test-job', 'vercel', async () => ({
        claimed: 3,
        succeeded: 2,
        dead: 1,
      }));
      expect(result).toEqual({ claimed: 3, succeeded: 2, dead: 1 });

      const row = await prisma.jobSchedulerHeartbeat.findFirstOrThrow({ where: { jobName: 'unit-test-job' } });
      expect(row.schedulerSource).toBe('vercel');
      expect(row.status).toBe('success');
      expect(row.claimedCount).toBe(3);
      expect(row.succeededCount).toBe(2);
      expect(row.failedCount).toBe(1);
      expect(row.finishedAt).not.toBeNull();
    });

    it('issuedフィールドをsucceededCountとして扱う(processNftMintsの結果形式)', async () => {
      await withSchedulerHeartbeat('unit-test-job', 'github-actions', async () => ({ claimed: 1, issued: 1, failed: 0 }));

      const row = await prisma.jobSchedulerHeartbeat.findFirstOrThrow({ where: { jobName: 'unit-test-job' } });
      expect(row.succeededCount).toBe(1);
      expect(row.failedCount).toBe(0);
    });

    it('例外発生時はstatus=failedとerrorを記録し、例外を再スローする', async () => {
      await expect(
        withSchedulerHeartbeat('unit-test-job', 'vercel', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const row = await prisma.jobSchedulerHeartbeat.findFirstOrThrow({ where: { jobName: 'unit-test-job' } });
      expect(row.status).toBe('failed');
      expect(row.error).toBe('boom');
    });
  });

  describe('checkPrimarySchedulerHealth', () => {
    it('主系(process-integration-outboxはvercel)による直近10分以内の成功があればok=true', async () => {
      await prisma.jobSchedulerHeartbeat.create({
        data: {
          jobName: TEST_JOB_NAME,
          schedulerSource: 'vercel',
          startedAt: new Date(),
          finishedAt: new Date(),
          status: 'success',
        },
      });

      const health = await checkPrimarySchedulerHealth(TEST_JOB_NAME);
      expect(health.expectedSource).toBe('vercel');
      expect(health.ok).toBe(true);
      expect(health.lastSuccessAt).not.toBeNull();
    });

    it('成功実績が一切ない場合はok=false・lastSuccessAt=null', async () => {
      const health = await checkPrimarySchedulerHealth(TEST_JOB_NAME);
      expect(health.ok).toBe(false);
      expect(health.lastSuccessAt).toBeNull();
    });

    it('未知のjob_nameはexpectedSource=unknownとなり、成功実績がなければok=false', async () => {
      const health = await checkPrimarySchedulerHealth('unknown-job-name');
      expect(health.expectedSource).toBe('unknown');
      expect(health.ok).toBe(false);
    });
  });
});
