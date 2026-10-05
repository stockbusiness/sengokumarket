import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { setSetting } from './settings';
import { resolveCommonUserId } from './externalCommonUserClient';

// 代理店HUB(sengoku-ai.com)向けcommon_user_id解決クライアント。SENNOKUNI_INTEGRATION_ENABLED
// (既定OFF)が有効化され、かつ接続情報(sennokuni_agency_hub_api_key/base_url)が揃うまで
// 一切外部へ送信しない("Feature Flagでdormantなコード"という方針)。
// 2026-10: 先方の開発者向けガイドで、実際の認証方式がHMACではなくx-api-key1本であることが
// 判明したため、それに合わせてテストも書き直す。
describe('externalCommonUserClient(代理店HUB common_user_id解決)', () => {
  const originalFlag = process.env.SENNOKUNI_INTEGRATION_ENABLED;

  beforeEach(() => {
    delete process.env.SENNOKUNI_INTEGRATION_ENABLED;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.SENNOKUNI_INTEGRATION_ENABLED = originalFlag;
    await prisma.setting.deleteMany({
      where: { key: { in: ['sennokuni_agency_hub_api_key', 'sennokuni_agency_hub_base_url'] } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('Feature Flag無効時はfetchを呼ばずnullを返す', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveCommonUserId({
      externalUserId: 'user-1',
      name: '山田太郎',
      email: 'a@example.com',
    });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Feature Flag有効でも接続情報が未設定ならfetchを呼ばずnullを返す', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveCommonUserId({ externalUserId: 'user-1', name: '山田太郎', email: 'a@example.com' });

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Feature Flag有効・接続情報設定済みならx-api-keyヘッダー付きでresolve APIを呼び、common_user_idを返す', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_agency_hub_api_key', 'api-key-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://sengoku-ai.com/');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, common_user_id: 'cu_test_00000001' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveCommonUserId({
      externalUserId: 'user-1',
      name: '山田太郎',
      email: 'a@example.com',
      phone: '09012345678',
    });

    expect(result).toEqual({ commonUserId: 'cu_test_00000001' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://sengoku-ai.com/api/common-users/resolve');
    expect(options.method).toBe('POST');
    expect(options.headers['x-api-key']).toBe('api-key-abc');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(options.body)).toMatchObject({
      system_key: 'sengoku-rr',
      external_user_id: 'user-1',
      display_name: '山田太郎',
      email: 'a@example.com',
      phone: '09012345678',
      create_if_missing: true,
    });
  });

  it('resolve APIが非2xxを返した場合はnullを返す', async () => {
    process.env.SENNOKUNI_INTEGRATION_ENABLED = 'true';
    await setSetting('sennokuni_agency_hub_api_key', 'api-key-abc');
    await setSetting('sennokuni_agency_hub_base_url', 'https://sengoku-ai.com');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }));

    const result = await resolveCommonUserId({ externalUserId: 'user-1', name: '山田太郎', email: 'a@example.com' });
    expect(result).toBeNull();
  });
});
