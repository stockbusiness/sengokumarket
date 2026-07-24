-- AlterTable
ALTER TABLE "integration_outbox_events" ADD COLUMN     "blocked_reason" TEXT;

-- AlterTable
ALTER TABLE "product_integration_rules" ADD COLUMN     "require_closing_agent_id" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "require_common_user_id" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "require_referral_session_key" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "require_sales_agent_id" BOOLEAN NOT NULL DEFAULT false;
