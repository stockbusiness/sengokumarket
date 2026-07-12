-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "explainer_agency_id" UUID,
ADD COLUMN     "explainer_influencer_id" UUID,
ADD COLUMN     "explainer_name" TEXT,
ADD COLUMN     "referral_hierarchy" JSONB;
