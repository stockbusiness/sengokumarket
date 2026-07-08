-- 外部代理店システム連携(仕様書v3.6.40): 親が未登録の代理店を受信した場合にエラーにせず保存し、
-- 親が後から届いた時点で自動的に再紐付けできるよう、未解決の親external_idを保持する列を追加する。
ALTER TABLE "agencies" ADD COLUMN IF NOT EXISTS "pending_parent_external_id" TEXT;
