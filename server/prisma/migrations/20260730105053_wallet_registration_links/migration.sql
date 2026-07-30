-- CreateTable
CREATE TABLE "wallet_registration_links" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_by" UUID NOT NULL,
    "revoked_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_registration_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_registration_links_token_hash_key" ON "wallet_registration_links"("token_hash");

-- CreateIndex
CREATE INDEX "wallet_registration_links_user_id_idx" ON "wallet_registration_links"("user_id");

-- AddForeignKey
ALTER TABLE "wallet_registration_links" ADD CONSTRAINT "wallet_registration_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
