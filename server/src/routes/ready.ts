import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { collectRequiredEnvErrors } from '../shared/config/env';
import { isSennokuniIntegrationEnabled } from '../services/sennokuniIntegrationConfig';

const router = Router();

// 本番安定化指示書Stage0: Vercelデプロイ成功と本番DB migration成功を混同しないための
// 専用エンドポイント。/api/healthはプロセス生存確認のみ(DBへ触れない)にとどめ、
// こちらでDB接続・必須migration適用状況・重要環境変数・Feature Flag状態を確認する。
// 秘密情報(接続文字列・鍵の値そのもの等)は一切レスポンスへ含めない。
const REQUIRED_MIGRATIONS = [
  'notification_outbox_events',
  'order_linking_jobs',
  'entitlement_outbox_blocking',
  'integration_outbox_dispatcher_hardening',
  'user_session_version',
  'rate_limit_buckets',
];

async function checkDatabase(): Promise<{ ok: boolean; error?: string }> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (e) {
    console.error('/api/ready: DB接続確認に失敗しました', e);
    return { ok: false, error: 'データベースに接続できません' };
  }
}

async function checkMigrations(): Promise<{ ok: boolean; missing?: string[]; error?: string }> {
  try {
    const applied = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
    `;
    const appliedNames = applied.map((m) => m.migration_name);
    const missing = REQUIRED_MIGRATIONS.filter((required) => !appliedNames.some((name) => name.includes(required)));
    return missing.length > 0 ? { ok: false, missing } : { ok: true };
  } catch (e) {
    console.error('/api/ready: migration適用状況の確認に失敗しました', e);
    return { ok: false, error: 'migration適用状況を確認できません' };
  }
}

router.get('/ready', async (_req, res) => {
  const envErrors = collectRequiredEnvErrors();
  // DBに触れられない状態でmigrationsを確認しても無意味なため、DB接続確認が失敗した
  // 場合はmigrations確認自体をスキップしてerror扱いにする。
  const database = await checkDatabase();
  const migrations = database.ok ? await checkMigrations() : { ok: false, error: 'DB接続不可のため確認をスキップしました' };

  const ready = envErrors.length === 0 && database.ok && migrations.ok;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    database: database.ok ? 'ok' : 'error',
    migrations: migrations.ok ? 'ok' : 'error',
    integrationEnabled: isSennokuniIntegrationEnabled(),
    ...(database.error ? { databaseError: database.error } : {}),
    ...(migrations.error ? { migrationsError: migrations.error } : {}),
    ...('missing' in migrations && migrations.missing ? { missingMigrations: migrations.missing } : {}),
    ...(envErrors.length > 0 ? { envErrors } : {}),
  });
});

export default router;
