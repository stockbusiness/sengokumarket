-- AlterTable
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "referred_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "referred_by_agency_id" UUID,
  ADD COLUMN IF NOT EXISTS "referred_by_code" TEXT,
  ADD COLUMN IF NOT EXISTS "referred_by_influencer_id" UUID,
  ADD COLUMN IF NOT EXISTS "referred_by_referral_link_id" UUID;
