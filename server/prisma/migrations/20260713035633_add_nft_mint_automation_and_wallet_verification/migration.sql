-- AlterTable
ALTER TABLE "nft_issues" ADD COLUMN     "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "metadata_uri" TEXT,
ADD COLUMN     "next_attempt_at" TIMESTAMP(3),
ADD COLUMN     "provider_request_id" TEXT,
ADD COLUMN     "submitted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "verification_method" TEXT,
ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "verified_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "wallet_verification_nonces" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_verification_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_change_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "previous_address" TEXT,
    "new_address" TEXT NOT NULL,
    "verification_method" TEXT NOT NULL,
    "changed_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_verification_nonces_nonce_key" ON "wallet_verification_nonces"("nonce");

-- CreateIndex
CREATE INDEX "wallet_change_logs_user_id_idx" ON "wallet_change_logs"("user_id");

-- AddForeignKey
ALTER TABLE "wallet_verification_nonces" ADD CONSTRAINT "wallet_verification_nonces_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_change_logs" ADD CONSTRAINT "wallet_change_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DataBackfill: 署名検証(verified)導入前にready_to_issueへ遷移していた行(=未検証ウォレット
-- での遷移)をwallet_requiredへ戻す。実際にオンチェーン発行された行は0件のため既存購入者への
-- 実害はなく、次回ログイン時に署名付きで登録し直してもらう形になる。
UPDATE "nft_issues" SET "status" = 'wallet_required', "wallet_address" = NULL
WHERE "status" = 'ready_to_issue';
