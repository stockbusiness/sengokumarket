import { Router } from 'express';
import { collectRequiredEnvErrors } from '../shared/config/env';
import { isSennokuniIntegrationEnabled } from '../services/sennokuniIntegrationConfig';
import { checkDatabaseHealth, checkMigrationsHealth } from '../services/readinessCheck';

const router = Router();

// 本番安定化指示書Stage0: Vercelデプロイ成功と本番DB migration成功を混同しないための
// 専用エンドポイント。/api/healthはプロセス生存確認のみ(DBへ触れない)にとどめ、
// こちらでDB接続・必須migration適用状況・重要環境変数・Feature Flag状態を確認する。
// 秘密情報(接続文字列・鍵の値そのもの等)は一切レスポンスへ含めない。
router.get('/ready', async (_req, res) => {
  const envErrors = collectRequiredEnvErrors();
  // DBに触れられない状態でmigrationsを確認しても無意味なため、DB接続確認が失敗した
  // 場合はmigrations確認自体をスキップしてerror扱いにする。
  const database = await checkDatabaseHealth();
  const migrations = database.ok ? await checkMigrationsHealth() : { ok: false, error: 'DB接続不可のため確認をスキップしました' };

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
