-- 銀行振込(手動確認型)決済手段の追加(仕様書外の拡張)。
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "payment_method" TEXT NOT NULL DEFAULT 'stripe';
