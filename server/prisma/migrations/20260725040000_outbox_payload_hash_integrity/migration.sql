-- AlterTable: original_payload/original_payload_hashを追加し、既存行はpayload/payload_hashで
-- バックフィルする(以後payload/payload_hashはdelivery_payload相当として扱う)。
ALTER TABLE "integration_outbox_events" ADD COLUMN "original_payload" JSONB;
ALTER TABLE "integration_outbox_events" ADD COLUMN "original_payload_hash" TEXT;

UPDATE "integration_outbox_events" SET "original_payload" = "payload", "original_payload_hash" = "payload_hash"
WHERE "original_payload" IS NULL;

ALTER TABLE "integration_outbox_events" ALTER COLUMN "original_payload" SET NOT NULL;
ALTER TABLE "integration_outbox_events" ALTER COLUMN "original_payload_hash" SET NOT NULL;

-- AlterTable: integration_event_attempts(試行履歴)へ送信先URL・request payload hash・
-- 応答本文の抜粋を追加する。
ALTER TABLE "integration_event_attempts" ADD COLUMN "request_payload_hash" TEXT;
ALTER TABLE "integration_event_attempts" ADD COLUMN "destination_url" TEXT;
ALTER TABLE "integration_event_attempts" ADD COLUMN "response_body_excerpt" TEXT;
