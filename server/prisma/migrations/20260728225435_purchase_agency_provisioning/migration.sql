-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "agency_account_id" TEXT,
ADD COLUMN     "agency_account_type" TEXT,
ADD COLUMN     "agency_login_email" TEXT,
ADD COLUMN     "agency_login_mode" TEXT,
ADD COLUMN     "agency_login_url" TEXT,
ADD COLUMN     "agency_login_url_expires_at" TIMESTAMP(3),
ADD COLUMN     "agency_provisioned_at" TIMESTAMP(3),
ADD COLUMN     "agency_provisioning_last_error" TEXT,
ADD COLUMN     "agency_provisioning_status" TEXT NOT NULL DEFAULT 'not_applicable';

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "agency_access_expires_days" INTEGER,
ADD COLUMN     "agency_access_mode" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "agency_login_redirect_path" TEXT,
ADD COLUMN     "agency_product_code" TEXT,
ADD COLUMN     "agency_role" TEXT;

-- CreateTable
CREATE TABLE "purchase_provisioning_jobs" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "common_user_id" TEXT,
    "action" TEXT NOT NULL DEFAULT 'provision',
    "deduplication_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "processing_token" TEXT,
    "processing_started_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "blocked_reason" TEXT,
    "response_json" JSONB,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_provisioning_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_provisioning_jobs_deduplication_key_key" ON "purchase_provisioning_jobs"("deduplication_key");

-- CreateIndex
CREATE INDEX "purchase_provisioning_jobs_status_next_attempt_at_idx" ON "purchase_provisioning_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "purchase_provisioning_jobs_order_id_idx" ON "purchase_provisioning_jobs"("order_id");

-- AddForeignKey
ALTER TABLE "purchase_provisioning_jobs" ADD CONSTRAINT "purchase_provisioning_jobs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 購入後代理店システム連携実装指示書 6.3章: agency_access_modeの許容値制約。
ALTER TABLE "products" ADD CONSTRAINT "products_agency_access_mode_check"
  CHECK ("agency_access_mode" IN ('none', 'customer_portal', 'agent_portal'));

-- 同 6.3章: agent_portalの場合はagencyRole・agencyProductCodeを必須にする。
ALTER TABLE "products" ADD CONSTRAINT "products_agency_access_mode_agent_portal_check"
  CHECK ("agency_access_mode" <> 'agent_portal' OR ("agency_role" IS NOT NULL AND "agency_product_code" IS NOT NULL));

-- purchase_provisioning_jobs.actionの許容値制約(order_linking_jobsのstatus同様、enumではなく
-- 文字列+CHECKで表現する既存方針に合わせる)。
ALTER TABLE "purchase_provisioning_jobs" ADD CONSTRAINT "purchase_provisioning_jobs_action_check"
  CHECK ("action" IN ('provision', 'revoke'));
