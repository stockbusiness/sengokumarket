-- 千ノ国全体統合 共通実装契約(2026-07-21)対応。
-- 既存の決済フローを壊さないよう、すべて追加的な変更(既存カラムの削除・型変更なし)。

-- AlterTable: orders(外部連携用スナップショット。既存のagencyId/influencerId/explainerName等は変更しない)
ALTER TABLE "orders" ADD COLUMN     "assigned_agency_id" TEXT,
ADD COLUMN     "closing_agent_id" TEXT,
ADD COLUMN     "common_user_id" TEXT,
ADD COLUMN     "common_user_resolution_status" TEXT NOT NULL DEFAULT 'unresolved',
ADD COLUMN     "correlation_id" TEXT,
ADD COLUMN     "referral_session_key" TEXT,
ADD COLUMN     "registration_referrer_agency_id" TEXT,
ADD COLUMN     "sales_agent_id" TEXT;

-- AlterTable: stripe_events(Inbox方式への移行。processed_atは処理完了時のみ設定するためNOT NULL解除)
ALTER TABLE "stripe_events" ADD COLUMN     "attempt_count" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "payload_hash" TEXT NOT NULL DEFAULT 'legacy-unknown',
ADD COLUMN     "processing_started_at" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'processing',
ALTER COLUMN "processed_at" DROP NOT NULL;

-- 既存行(このマイグレーション以前に記録されたイベント)は、旧方式で「INSERT時点で無条件に
-- processedAtを確定」していたものであり、実際に業務処理まで完了していたとみなしsucceededに
-- 分類する(再処理・Stripe再送時の再実行対象にしない)。
UPDATE "stripe_events" SET "status" = 'succeeded' WHERE "processed_at" IS NOT NULL;

-- payload_hashのDEFAULTは上記バックフィルのための一時的な安全策。アプリケーションコードは
-- 以後、必ず明示的にpayload_hashを指定してINSERTするため、DEFAULTは残さない。
ALTER TABLE "stripe_events" ALTER COLUMN "payload_hash" DROP DEFAULT;

-- AlterTable: users(共通ユーザーID。代理店システムのresolve API結果を保存するのみで独自発番しない)
ALTER TABLE "users" ADD COLUMN     "common_user_id" TEXT;

-- CreateTable: 外部システムごとのユーザーID対応(system_account_links相当)
CREATE TABLE "external_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "system_key" TEXT NOT NULL DEFAULT 'sengoku-market',
    "external_user_id" TEXT NOT NULL,
    "common_user_id" TEXT,
    "identity_type" TEXT NOT NULL,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable: 商品ごとのentitlement送信先ルーティング設定
CREATE TABLE "product_integration_rules" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_code" TEXT,
    "entitlement_target_system_key" TEXT,
    "entitlement_type" TEXT,
    "reward_rule_id" TEXT,
    "revoke_on_refund" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_integration_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable: 下流システムへのイベント送信Outbox
CREATE TABLE "integration_outbox_events" (
    "id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_version" TEXT NOT NULL DEFAULT '1.0',
    "destination_system_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "correlation_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "external_identities_common_user_id_idx" ON "external_identities"("common_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_identities_system_key_external_user_id_key" ON "external_identities"("system_key", "external_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_integration_rules_product_id_key" ON "product_integration_rules"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_outbox_events_event_id_key" ON "integration_outbox_events"("event_id");

-- CreateIndex
CREATE INDEX "integration_outbox_events_status_idx" ON "integration_outbox_events"("status");

-- CreateIndex
CREATE INDEX "integration_outbox_events_destination_system_key_idx" ON "integration_outbox_events"("destination_system_key");

-- CreateIndex
CREATE INDEX "stripe_events_status_idx" ON "stripe_events"("status");

-- CreateIndex
CREATE UNIQUE INDEX "users_common_user_id_key" ON "users"("common_user_id");

-- AddForeignKey
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_integration_rules" ADD CONSTRAINT "product_integration_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
