-- 本番安定化指示書Stage12(15.3「migration drift check」)で検出された、手書きmigration
-- (20260725030000_product_integration_rules_one_to_many)がPostgresの識別子長制限を避けて
-- 短縮した名前とPrismaの標準命名規則とのずれを解消する(データ・制約の実体は変更しない)。
ALTER INDEX "product_integration_rules_product_id_entitlement_target_s_key" RENAME TO "product_integration_rules_product_id_entitlement_target_sys_key";
