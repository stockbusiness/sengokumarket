-- CreateTable
CREATE TABLE "agency_sso_login_failure_logs" (
    "id" UUID NOT NULL,
    "error_code" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agency_sso_login_failure_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agency_sso_login_failure_logs_created_at_idx" ON "agency_sso_login_failure_logs"("created_at");
