/*
  Warnings:

  - Added the required column `original_amount` to the `orders` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
-- original_amountは既存注文がある場合に備え、いったんNULL許容で追加してtotal_amountで
-- バックフィルしてからNOT NULLにする(クーポン未使用注文はoriginal_amount=total_amountとする)。
ALTER TABLE "orders" ADD COLUMN     "coupon_code" TEXT,
ADD COLUMN     "coupon_discount_amount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "coupon_id" UUID,
ADD COLUMN     "original_amount" INTEGER;

UPDATE "orders" SET "original_amount" = "total_amount" WHERE "original_amount" IS NULL;

ALTER TABLE "orders" ALTER COLUMN "original_amount" SET NOT NULL;

-- AlterTable
ALTER TABLE "referral_links" ADD COLUMN     "coupon_auto_apply" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "coupon_id" UUID;

-- CreateTable
CREATE TABLE "coupons" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "discount_type" TEXT NOT NULL,
    "discount_amount" INTEGER,
    "discount_percentage" DECIMAL(5,2),
    "maximum_discount_amount" INTEGER,
    "minimum_order_amount" INTEGER,
    "starts_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "total_usage_limit" INTEGER,
    "per_customer_usage_limit" INTEGER NOT NULL DEFAULT 1,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "reserved_count" INTEGER NOT NULL DEFAULT 0,
    "product_scope_type" TEXT NOT NULL DEFAULT 'all',
    "agency_scope_type" TEXT NOT NULL DEFAULT 'all',
    "customer_scope_type" TEXT NOT NULL DEFAULT 'all',
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "restore_on_cancel" BOOLEAN NOT NULL DEFAULT true,
    "created_by_admin_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_products" (
    "id" UUID NOT NULL,
    "coupon_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "relation_type" TEXT NOT NULL DEFAULT 'include',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_agencies" (
    "id" UUID NOT NULL,
    "coupon_id" UUID NOT NULL,
    "agency_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_agencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_customers" (
    "id" UUID NOT NULL,
    "coupon_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_usages" (
    "id" UUID NOT NULL,
    "coupon_id" UUID NOT NULL,
    "user_id" UUID,
    "agency_id" UUID,
    "order_id" UUID,
    "original_amount" INTEGER NOT NULL,
    "discount_amount" INTEGER NOT NULL,
    "final_amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "reserved_at" TIMESTAMP(3),
    "used_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupon_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_products_coupon_id_product_id_key" ON "coupon_products"("coupon_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_agencies_coupon_id_agency_id_key" ON "coupon_agencies"("coupon_id", "agency_id");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_customers_coupon_id_user_id_key" ON "coupon_customers"("coupon_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_usages_order_id_key" ON "coupon_usages"("order_id");

-- CreateIndex
CREATE INDEX "coupon_usages_status_idx" ON "coupon_usages"("status");

-- AddForeignKey
ALTER TABLE "referral_links" ADD CONSTRAINT "referral_links_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_products" ADD CONSTRAINT "coupon_products_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_products" ADD CONSTRAINT "coupon_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_agencies" ADD CONSTRAINT "coupon_agencies_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_agencies" ADD CONSTRAINT "coupon_agencies_agency_id_fkey" FOREIGN KEY ("agency_id") REFERENCES "agencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_customers" ADD CONSTRAINT "coupon_customers_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_customers" ADD CONSTRAINT "coupon_customers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_usages" ADD CONSTRAINT "coupon_usages_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_usages" ADD CONSTRAINT "coupon_usages_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
