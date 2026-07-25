-- DropIndex (1商品につき1送信先という制約を廃止し、1:N化する)
DROP INDEX "product_integration_rules_product_id_key";

-- AlterTable
ALTER TABLE "product_integration_rules" ADD COLUMN "reward_amount_per_unit" INTEGER;
ALTER TABLE "product_integration_rules" ADD COLUMN "reward_calculation_mode" TEXT;
ALTER TABLE "product_integration_rules" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE UNIQUE INDEX "product_integration_rules_product_id_entitlement_target_s_key" ON "product_integration_rules"("product_id", "entitlement_target_system_key", "entitlement_type");
