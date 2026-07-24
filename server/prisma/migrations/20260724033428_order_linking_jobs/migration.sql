-- CreateTable
CREATE TABLE "order_linking_jobs" (
    "id" UUID NOT NULL,
    "job_type" TEXT NOT NULL,
    "user_id" UUID,
    "order_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "processing_token" TEXT,
    "processing_started_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_linking_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_linking_jobs_status_next_attempt_at_idx" ON "order_linking_jobs"("status", "next_attempt_at");
