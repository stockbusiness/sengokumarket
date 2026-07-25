-- AlterTable
ALTER TABLE "order_linking_jobs" ADD COLUMN "deduplication_key" TEXT;
ALTER TABLE "order_linking_jobs" ADD COLUMN "blocked_reason" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "order_linking_jobs_deduplication_key_key" ON "order_linking_jobs"("deduplication_key");
