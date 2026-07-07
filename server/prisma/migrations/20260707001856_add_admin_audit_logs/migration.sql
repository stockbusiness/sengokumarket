-- CreateTable
CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "actor_email" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "request_body" JSONB,
    "status_code" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "admin_audit_logs_created_at_idx" ON "admin_audit_logs"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "admin_audit_logs_actor_user_id_idx" ON "admin_audit_logs"("actor_user_id");
