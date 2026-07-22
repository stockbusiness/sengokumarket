-- 2026-07-22 千ノ国全体連携パッケージ対応: Outbox dispatcherのstale processing検知用にupdated_atを追加する。
-- integration_outbox_eventsは現時点で本番投入されていない(常にpendingのみ)ため、既存行はcreated_atで初期化する。
ALTER TABLE "integration_outbox_events" ADD COLUMN "updated_at" TIMESTAMP(3);
UPDATE "integration_outbox_events" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;
ALTER TABLE "integration_outbox_events" ALTER COLUMN "updated_at" SET NOT NULL;
