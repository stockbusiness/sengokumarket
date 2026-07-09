-- CreateTable
CREATE TABLE "sso_used_jti" (
    "id" UUID NOT NULL,
    "jti" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "aud" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_used_jti_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sso_used_jti_jti_key" ON "sso_used_jti"("jti");

-- CreateIndex
CREATE INDEX "sso_used_jti_expires_at_idx" ON "sso_used_jti"("expires_at");
