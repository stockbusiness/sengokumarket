-- AlterTable
ALTER TABLE "agencies" ADD COLUMN     "external_id" TEXT,
ADD COLUMN     "parent_agency_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "agency_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "agencies_external_id_key" ON "agencies"("external_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_agency_id_fkey" FOREIGN KEY ("agency_id") REFERENCES "agencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agencies" ADD CONSTRAINT "agencies_parent_agency_id_fkey" FOREIGN KEY ("parent_agency_id") REFERENCES "agencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

