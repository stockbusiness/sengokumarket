-- CreateTable
CREATE TABLE "job_scheduler_heartbeats" (
    "id" UUID NOT NULL,
    "job_name" TEXT NOT NULL,
    "scheduler_source" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "claimed_count" INTEGER,
    "succeeded_count" INTEGER,
    "failed_count" INTEGER,
    "error" TEXT,

    CONSTRAINT "job_scheduler_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_scheduler_heartbeats_job_name_scheduler_source_finishe_idx" ON "job_scheduler_heartbeats"("job_name", "scheduler_source", "finished_at");
