-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agency_application_submitted_at" TIMESTAMP(3);
