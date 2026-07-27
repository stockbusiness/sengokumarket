-- CI復旧・本番移行前 最終指示書 Stage2: schema.prismaとmigration履歴のdrift解消。
-- job_scheduler_heartbeatsのindex名を、schema.prisma(@@index([jobName, schedulerSource,
-- finishedAt]))からPrismaが自動導出する正しい名前(63byte制限に収まるよう末尾を
-- "finished_idx"で切り詰めたもの)に合わせる。20260726183729_job_scheduler_heartbeatsの
-- migration.sqlを手作業で書いた際に1文字誤って"finishe_idx"としてしまっていたための修正。
-- 既存migrationファイルは編集せず、RENAMEのみを行う新規migrationとして追加する
-- (destructiveな変更ではなく、既存データにも影響しない)。
ALTER INDEX "job_scheduler_heartbeats_job_name_scheduler_source_finishe_idx"
  RENAME TO "job_scheduler_heartbeats_job_name_scheduler_source_finished_idx";
