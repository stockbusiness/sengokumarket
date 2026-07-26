-- AlterTable
ALTER TABLE "integration_outbox_events" ADD COLUMN "deduplication_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "integration_outbox_events_deduplication_key_key" ON "integration_outbox_events"("deduplication_key");
