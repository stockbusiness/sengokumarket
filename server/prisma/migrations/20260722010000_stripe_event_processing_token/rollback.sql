-- ロールバック: processing_tokenカラムを削除する。
-- 指示書13.2の方針通り、原則としてロールバックはアプリコードのみを戻し、このSQLの実行自体は
-- データ確認なしに行わないこと。
ALTER TABLE "stripe_events" DROP COLUMN IF EXISTS "processing_token";
