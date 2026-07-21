-- ロールバック手順(手動実行用。Prismaのdown migrationは自動生成されないため、この
-- マイグレーション専用に用意する)。適用は上から順に。
-- 注意: integration_outbox_events / product_integration_rules / external_identitiesに
-- データが投入された後にロールバックする場合、そのデータは失われる。

ALTER TABLE "product_integration_rules" DROP CONSTRAINT IF EXISTS "product_integration_rules_product_id_fkey";
ALTER TABLE "external_identities" DROP CONSTRAINT IF EXISTS "external_identities_user_id_fkey";

DROP TABLE IF EXISTS "integration_outbox_events";
DROP TABLE IF EXISTS "product_integration_rules";
DROP TABLE IF EXISTS "external_identities";

ALTER TABLE "users" DROP COLUMN IF EXISTS "common_user_id";

ALTER TABLE "stripe_events" DROP COLUMN IF EXISTS "attempt_count";
ALTER TABLE "stripe_events" DROP COLUMN IF EXISTS "last_error";
ALTER TABLE "stripe_events" DROP COLUMN IF EXISTS "payload_hash";
ALTER TABLE "stripe_events" DROP COLUMN IF EXISTS "processing_started_at";
ALTER TABLE "stripe_events" DROP COLUMN IF EXISTS "status";
-- processed_atを元のNOT NULLへ戻す前に、ロールバック時点でNULLの行(処理未完了のまま
-- ロールバックされる行)があればアプリのロールバック前に手動確認すること。
ALTER TABLE "stripe_events" ALTER COLUMN "processed_at" SET NOT NULL;

ALTER TABLE "orders" DROP COLUMN IF EXISTS "assigned_agency_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "closing_agent_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "common_user_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "common_user_resolution_status";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "correlation_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "referral_session_key";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "registration_referrer_agency_id";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "sales_agent_id";
