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
    return missing.length > 0 ? { ok: false, missing } : { ok: true };
  } catch (e) {
    console.error('readinessCheck: migration適用状況の確認に失敗しました', e);
    return { ok: false, error: 'migration適用状況を確認できません' };
  }
}
