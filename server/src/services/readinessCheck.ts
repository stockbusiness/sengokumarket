import { prisma } from '../lib/prisma';

// 本番安定化指示書Stage0(/api/ready)・Stage11(14.3「migration/readiness error」アラート)で
// 共用する。DB接続・必須migration適用状況の確認ロジックをここへ集約する。
export const REQUIRED_MIGRATIONS = [
  'notification_outbox_events',
  'order_linking_jobs',
  'entitlement_outbox_blocking',
  'integration_outbox_dispatcher_hardening',
  'user_session_version',
  'rate_limit_buckets',
  // Wallet Claim本番前安定化指示書(2026-07-25)Phase8(10.2「本番migration不足」)・Phase9
  // (11.1「必須確認対象」)。
  'wallet_claim_collectible_delivery',
  'wallet_claim_stabilization',
  'product_integration_rules_one_to_many',
  'outbox_payload_hash_integrity',
  'order_wallet_transactions',
  // 実際のmigrationフォルダ名は`fix_product_integration_rules_index_name`(語順が異なる)。
  // 指示書の表記そのままでは部分一致しないため、実フォルダ名の並びに合わせる。
  'fix_product_integration_rules_index_name',
  'rate_limit_bucket_updated_at_index',
  // 最終安定化指示書Phase4「Readiness最新化」。
  'wallet_claim_item_product_code',
  'integration_outbox_dedup_key',
];

// Wallet Claim本番前安定化指示書(2026-07-25)Phase9(11.2「推奨方式」): migration名の部分一致
// だけに依存すると、_prisma_migrations自体が壊れている・手動編集された場合に検知できない。
// 実際に必須カラムへSELECTすることで、実スキーマの不足を直接検知する(11.3「migration table
// が壊れていても検知」)。LIMIT 0のためデータ件数に関わらず高速。
const SENTINEL_QUERIES: { label: string; run: () => Promise<unknown> }[] = [
  { label: 'wallet_claims.token_hash', run: () => prisma.$queryRaw`SELECT token_hash FROM wallet_claims LIMIT 0` },
  { label: 'collectible_deliveries.entitlement_id', run: () => prisma.$queryRaw`SELECT entitlement_id FROM collectible_deliveries LIMIT 0` },
  { label: 'nft_issues.serial_number', run: () => prisma.$queryRaw`SELECT serial_number FROM nft_issues LIMIT 0` },
  { label: 'integration_outbox_events.original_payload', run: () => prisma.$queryRaw`SELECT original_payload FROM integration_outbox_events LIMIT 0` },
  { label: 'order_wallet_transactions.idempotency_key', run: () => prisma.$queryRaw`SELECT idempotency_key FROM order_wallet_transactions LIMIT 0` },
  // 最終安定化指示書Phase4「Readiness最新化」。
  { label: 'wallet_claim_items.product_code', run: () => prisma.$queryRaw`SELECT product_code FROM wallet_claim_items LIMIT 0` },
  { label: 'integration_outbox_events.deduplication_key', run: () => prisma.$queryRaw`SELECT deduplication_key FROM integration_outbox_events LIMIT 0` },
];

export async function checkDatabaseHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (e) {
    console.error('readinessCheck: DB接続確認に失敗しました', e);
    return { ok: false, error: 'データベースに接続できません' };
  }
}

export async function checkMigrationsHealth(): Promise<{ ok: boolean; missing?: string[]; error?: string }> {
  try {
    const applied = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
    `;
    const appliedNames = applied.map((m) => m.migration_name);
    const missing = REQUIRED_MIGRATIONS.filter((required) => !appliedNames.some((name) => name.includes(required)));

    const missingColumns: string[] = [];
    for (const sentinel of SENTINEL_QUERIES) {
      try {
        await sentinel.run();
      } catch {
        missingColumns.push(sentinel.label);
      }
    }

    const allMissing = [...missing, ...missingColumns];
    return allMissing.length > 0 ? { ok: false, missing: allMissing } : { ok: true };
  } catch (e) {
    console.error('readinessCheck: migration適用状況の確認に失敗しました', e);
    return { ok: false, error: 'migration適用状況を確認できません' };
  }
}
