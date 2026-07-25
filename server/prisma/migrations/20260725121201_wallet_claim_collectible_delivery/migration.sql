-- AlterTable
ALTER TABLE "nft_issues" ADD COLUMN     "serial_number" INTEGER;

-- AlterTable
ALTER TABLE "product_integration_rules" ADD COLUMN     "asset_code" TEXT,
ADD COLUMN     "collectible_rarity" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "nft_serial_counter" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "wallet_claims" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "common_user_id" TEXT,
    "ove_account_id" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collectible_deliveries" (
    "id" UUID NOT NULL,
    "wallet_claim_id" UUID NOT NULL,
    "nft_issue_id" UUID NOT NULL,
    "entitlement_id" TEXT NOT NULL,
    "common_user_id" TEXT NOT NULL,
    "ove_account_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "delivered_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "last_error" TEXT,
    "outbox_event_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collectible_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_claim_audit_logs" (
    "id" UUID NOT NULL,
    "wallet_claim_id" UUID,
    "order_id" UUID,
    "event_type" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_claim_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_claim_api_nonces" (
    "id" UUID NOT NULL,
    "nonce" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_claim_api_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_claims_order_id_key" ON "wallet_claims"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_claims_token_hash_key" ON "wallet_claims"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "collectible_deliveries_nft_issue_id_key" ON "collectible_deliveries"("nft_issue_id");

-- CreateIndex
CREATE UNIQUE INDEX "collectible_deliveries_entitlement_id_key" ON "collectible_deliveries"("entitlement_id");

-- CreateIndex
CREATE INDEX "collectible_deliveries_status_idx" ON "collectible_deliveries"("status");

-- CreateIndex
CREATE INDEX "wallet_claim_audit_logs_wallet_claim_id_idx" ON "wallet_claim_audit_logs"("wallet_claim_id");

-- CreateIndex
CREATE INDEX "wallet_claim_audit_logs_created_at_idx" ON "wallet_claim_audit_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_claim_api_nonces_nonce_key" ON "wallet_claim_api_nonces"("nonce");

-- CreateIndex
CREATE UNIQUE INDEX "nft_issues_product_id_serial_number_key" ON "nft_issues"("product_id", "serial_number");

-- AddForeignKey
ALTER TABLE "wallet_claims" ADD CONSTRAINT "wallet_claims_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collectible_deliveries" ADD CONSTRAINT "collectible_deliveries_wallet_claim_id_fkey" FOREIGN KEY ("wallet_claim_id") REFERENCES "wallet_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collectible_deliveries" ADD CONSTRAINT "collectible_deliveries_nft_issue_id_fkey" FOREIGN KEY ("nft_issue_id") REFERENCES "nft_issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collectible_deliveries" ADD CONSTRAINT "collectible_deliveries_outbox_event_id_fkey" FOREIGN KEY ("outbox_event_id") REFERENCES "integration_outbox_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_claim_audit_logs" ADD CONSTRAINT "wallet_claim_audit_logs_wallet_claim_id_fkey" FOREIGN KEY ("wallet_claim_id") REFERENCES "wallet_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

