-- 2026-07-22指示書 Stage1: stripe_eventsに処理所有権トークンを追加する。
-- 既存行には値を入れない(nullable・デフォルトなし)。旧アプリコードへロールバックしても
-- このカラムが参照されないため、追加のみで安全に共存できる(指示書13.2)。
ALTER TABLE "stripe_events" ADD COLUMN "processing_token" TEXT;
