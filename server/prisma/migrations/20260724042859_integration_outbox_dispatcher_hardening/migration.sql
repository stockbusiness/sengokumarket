-- AlterTable
ALTER TABLE "integration_outbox_events" ADD COLUMN     "processing_started_at" TIMESTAMP(3),
ADD COLUMN     "processing_token" TEXT;

-- CreateTable
CREATE TABLE "integration_event_attempts" (
    "id" UUID NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "http_status" INTEGER,
    "result" TEXT NOT NULL,
    "error" TEXT,
    "processing_token" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_event_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_event_attempts_outbox_event_id_idx" ON "integration_event_attempts"("outbox_event_id");

-- AddForeignKey
ALTER TABLE "integration_event_attempts" ADD CONSTRAINT "integration_event_attempts_outbox_event_id_fkey" FOREIGN KEY ("outbox_event_id") REFERENCES "integration_outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
