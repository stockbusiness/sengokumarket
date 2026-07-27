import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { checkDatabaseHealth, checkMigrationsHealth, REQUIRED_MIGRATIONS } from './readinessCheck';

// Wallet Claim本番前安定化指示書(2026-07-25)Phase9(11章「/api/ready最新化」)。
describe('readinessCheck', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checkDatabaseHealth: 実際のDBに接続できればok:trueを返す', async () => {
    const result = await checkDatabaseHealth();
    expect(result.ok).toBe(true);
  });

  it('checkMigrationsHealth: 実際のスキーマに必須migration・必須カラムが揃っていればok:trueを返す', async () => {
    const result = await checkMigrationsHealth();
    expect(result.ok).toBe(true);
    expect(result.missing).toBeUndefined();
  });

  // 11.2「推奨方式・sentinel query」・11.3「必須カラム不足で503」「migration tableが壊れて
  // いても検知」: _prisma_migrations上は必須migrationが適用済みとして記録されていても、
  // 実際に必須カラムへSELECTした結果失敗すれば検知できることを確認する。
  it('checkMigrationsHealth: sentinel query(必須カラム確認)が失敗すればmigration名が揃っていてもok:falseになる', async () => {
    const original = prisma.$queryRaw.bind(prisma);
    vi.spyOn(prisma, '$queryRaw').mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = Array.isArray(strings) ? strings.join('') : String(strings);
      if (text.includes('wallet_claims')) {
        return Promise.reject(new Error('column "token_hash" does not exist'));
      }
      return original(strings, ...values);
    }) as typeof prisma.$queryRaw);

    const result = await checkMigrationsHealth();
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('wallet_claims.token_hash');
  });

  it('checkMigrationsHealth: 複数のsentinel queryが失敗すればすべてmissingへ含まれる', async () => {
    const original = prisma.$queryRaw.bind(prisma);
    vi.spyOn(prisma, '$queryRaw').mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = Array.isArray(strings) ? strings.join('') : String(strings);
      if (text.includes('collectible_deliveries') || text.includes('order_wallet_transactions')) {
        return Promise.reject(new Error('relation does not exist'));
      }
      return original(strings, ...values);
    }) as typeof prisma.$queryRaw);

    const result = await checkMigrationsHealth();
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('collectible_deliveries.entitlement_id');
    expect(result.missing).toContain('order_wallet_transactions.idempotency_key');
  });

  // 最終安定化指示書Phase4「今後の更新漏れを防ぐ」: migration追加時にREQUIRED_MIGRATIONSへの
  // 登録を忘れると、_prisma_migrations上は適用済みでも新カラム・新テーブルの不足を検知できない
  // (checkMigrationsHealthは名前一致するmigrationがREQUIRED_MIGRATIONS側にあることが前提のため)。
  // 最新のmigrationフォルダが登録漏れなら、このテストがCIで失敗して気づけるようにする。
  it('migration directoryの最新フォルダはREQUIRED_MIGRATIONSに登録されている(登録漏れの検知)', () => {
    const migrationsDir = path.resolve(__dirname, '../../prisma/migrations');
    const latest = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .at(-1);

    expect(latest).toBeTruthy();
    expect(REQUIRED_MIGRATIONS.some((required) => latest!.includes(required))).toBe(true);
  });
});
