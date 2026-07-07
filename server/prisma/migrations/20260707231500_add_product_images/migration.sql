-- 商品画像の複数枚対応(仕様書外の拡張)。
-- 既存のimage_url(単一画像)をimages配列へ移行し、image_urlは廃止する。
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "images" TEXT[] NOT NULL DEFAULT '{}';

UPDATE "products"
SET "images" = ARRAY["image_url"]
WHERE "image_url" IS NOT NULL AND "image_url" <> '' AND cardinality("images") = 0;

ALTER TABLE "products" DROP COLUMN IF EXISTS "image_url";
