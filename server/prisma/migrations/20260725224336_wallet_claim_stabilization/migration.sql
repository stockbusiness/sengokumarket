-- AlterTable
ALTER TABLE "wallet_claims" ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "last_reissued_at" TIMESTAMP(3),
ADD COLUMN     "manual_review_required_at" TIMESTAMP(3),
ADD COLUMN     "reissue_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "revoked_at" TIMESTAMP(3),
ADD COLUMN     "token_version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "wallet_claim_items" (
    "id" UUID NOT NULL,
    "wallet_claim_id" UUID NOT NULL,
    "nft_issue_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_integration_rule_id" UUID NOT NULL,
    "destination_system_key" TEXT NOT NULL,
    "entitlement_type" TEXT NOT NULL,
    "asset_code" TEXT,
    "serial_number" INTEGER,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image_url" TEXT,
    "thumbnail_url" TEXT,
    "image_hash" TEXT,
    "rarity" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_claim_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_claim_items_nft_issue_id_key" ON "wallet_claim_items"("nft_issue_id");

-- CreateIndex
CREATE INDEX "wallet_claim_items_wallet_claim_id_idx" ON "wallet_claim_items"("wallet_claim_id");

-- CreateIndex
CREATE INDEX "wallet_claim_api_nonces_created_at_idx" ON "wallet_claim_api_nonces"("created_at");

-- AddForeignKey
ALTER TABLE "wallet_claim_items" ADD CONSTRAINT "wallet_claim_items_wallet_claim_id_fkey" FOREIGN KEY ("wallet_claim_id") REFERENCES "wallet_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_claim_items" ADD CONSTRAINT "wallet_claim_items_nft_issue_id_fkey" FOREIGN KEY ("nft_issue_id") REFERENCES "nft_issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

