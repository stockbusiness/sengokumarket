import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';

const syncAgencyHierarchyFromExternalSystem = vi.fn(async () => ({ agenciesSynced: 2, applicationsApproved: 0 }));

vi.mock('../services/agencyHierarchySync', () => ({
  syncAgencyHierarchyFromExternalSystem: () => syncAgencyHierarchyFromExternalSystem(),
}));

const app = createApp();

describe('内部cron: 外部代理店システム階層同期(仕様書外の拡張)', () => {
  const originalSecret = process.env.CRON_SECRET;

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('CRON_SECRET未設定の場合は503', async () => {
    delete process.env.CRON_SECRET;
    const res = await request(app).get('/api/internal/cron/sync-agency-hierarchy');
    expect(res.status).toBe(503);
  });

  it('Authorizationヘッダーが一致しない場合は401', async () => {
    process.env.CRON_SECRET = 'test-cron-secret';
    const res = await request(app)
      .get('/api/internal/cron/sync-agency-hierarchy')
      .set('Authorization', 'Bearer wrong-secret');
    expect(res.status).toBe(401);
  });

  it('正しいCRON_SECRETで同期が実行される', async () => {
    process.env.CRON_SECRET = 'test-cron-secret';
    const res = await request(app)
      .get('/api/internal/cron/sync-agency-hierarchy')
      .set('Authorization', 'Bearer test-cron-secret');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agenciesSynced: 2, applicationsApproved: 0 });
  });
});
